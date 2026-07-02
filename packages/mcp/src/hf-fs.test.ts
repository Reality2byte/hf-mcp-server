import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	downloadFile,
	datasetInfo,
	HubApiError,
	listDatasets,
	listFiles,
	listModels,
	listSpaces,
	modelInfo,
	pathsInfo,
	spaceInfo,
	whoAmI,
} from '@huggingface/hub';
import { HF_FS_MAX_OUTPUT_CHARS, HF_FS_TOOL_CONFIG, HfFsTool, formatHfFsMarkdown, parseHfFsUri } from './hf-fs.js';

vi.mock('@huggingface/hub', () => ({
	HubApiError: class HubApiError extends Error {
		constructor(
			public readonly url: string,
			public readonly statusCode: number,
			public readonly requestId?: string
		) {
			super();
		}
	},
	HUB_URL: 'https://huggingface.co',
	listFiles: vi.fn(),
	listModels: vi.fn(),
	listDatasets: vi.fn(),
	listSpaces: vi.fn(),
	modelInfo: vi.fn(),
	datasetInfo: vi.fn(),
	spaceInfo: vi.fn(),
	pathsInfo: vi.fn(),
	downloadFile: vi.fn(),
	whoAmI: vi.fn(),
}));

async function* entries<T>(items: T[]): AsyncGenerator<T> {
	await Promise.resolve();
	for (const item of items) {
		yield item;
	}
}

describe('HfFsTool config', () => {
	it('describes omitted owner behavior with the authenticated username when available', () => {
		const config = HfFsTool.createToolConfig('alice');

		expect(config.description).toContain('default to alice');
		expect(config.schema.shape.uri.description).toContain('omitted owner defaults to alice');
	});

	it('describes owner requirements for anonymous users', () => {
		const config = HfFsTool.createToolConfig();

		expect(config.description).toContain('Anonymous requests must include an owner');
		expect(config.schema.shape.uri.description).toContain('anonymous requests must include an owner');
	});
});

describe('parseHfFsUri', () => {
	it('parses typed repo URIs with revision and path', () => {
		expect(parseHfFsUri('hf://datasets/org/repo@refs/pr/3/data/train.jsonl')).toEqual({
			kind: 'repo',
			repo: { type: 'dataset', name: 'org/repo' },
			repoType: 'dataset',
			repoId: 'org/repo',
			namespace: 'org',
			revision: 'refs/pr/3',
			path: 'data/train.jsonl',
		});
	});

	it('parses Hub special refs and encoded slash-containing revisions', () => {
		expect(parseHfFsUri('hf://datasets/org/repo@refs/convert/parquet-v2/data/train.parquet')).toEqual({
			kind: 'repo',
			repo: { type: 'dataset', name: 'org/repo' },
			repoType: 'dataset',
			repoId: 'org/repo',
			namespace: 'org',
			revision: 'refs/convert/parquet-v2',
			path: 'data/train.parquet',
		});
		expect(parseHfFsUri('hf://models/org/repo@refs%2Fheads%2Ffeature/README.md')).toEqual({
			kind: 'repo',
			repo: { type: 'model', name: 'org/repo' },
			repoType: 'model',
			repoId: 'org/repo',
			namespace: 'org',
			revision: 'refs/heads/feature',
			path: 'README.md',
		});
	});

	it('rejects unescaped slash-containing revision forms that would otherwise parse ambiguously', () => {
		expect(() => parseHfFsUri('hf://models/org/repo@refs/heads/feature/README.md')).toThrow(
			"Revision names containing '/' must be percent-encoded"
		);
		expect(() => parseHfFsUri('hf://models/org/repo@refs/tags/v1/README.md')).toThrow(
			"Revision names containing '/' must be percent-encoded"
		);
	});

	it('parses bucket URIs without revisions', () => {
		expect(parseHfFsUri('hf://buckets/org/bucket/images/cat%201.png')).toEqual({
			kind: 'repo',
			repo: { type: 'bucket', name: 'org/bucket' },
			repoType: 'bucket',
			repoId: 'org/bucket',
			namespace: 'org',
			path: 'images/cat 1.png',
		});
	});

	it('parses namespace listing URIs', () => {
		expect(parseHfFsUri('hf://models/openai')).toEqual({
			kind: 'namespace',
			repoType: 'model',
			namespace: 'openai',
			path: '',
		});
		expect(parseHfFsUri('hf://buckets')).toEqual({
			kind: 'namespace',
			repoType: 'bucket',
			path: '',
		});
	});

	it('rejects singular type prefixes', () => {
		expect(() => parseHfFsUri('hf://model/org/repo')).toThrow("Invalid URI type 'model'");
	});
});

describe('HfFsTool', () => {
	beforeEach(() => {
		vi.mocked(listFiles).mockReset();
		vi.mocked(listModels).mockReset();
		vi.mocked(listDatasets).mockReset();
		vi.mocked(listSpaces).mockReset();
		vi.mocked(modelInfo).mockReset();
		vi.mocked(datasetInfo).mockReset();
		vi.mocked(spaceInfo).mockReset();
		vi.mocked(pathsInfo).mockReset();
		vi.mocked(downloadFile).mockReset();
		vi.mocked(whoAmI).mockReset();
		vi.stubGlobal('fetch', vi.fn());
	});

	it('lists entries recursively with glob, type filter, offset, and limit', async () => {
		vi.mocked(listFiles).mockReturnValue(
			entries([
				{ type: 'directory', path: 'weights', size: 0 },
				{ type: 'file', path: 'weights/a.gguf', size: 10, lfs: { oid: '1', size: 10, pointerSize: 120 } },
				{ type: 'file', path: 'weights/b.safetensors', size: 20 },
				{ type: 'file', path: 'weights/c.gguf', size: 30 },
			])
		);

		const result = await new HfFsTool('token').run({
			op: 'ls',
			uri: 'hf://models/org/repo/weights',
			recursive: true,
			glob: '*.gguf',
			entry_type: 'file',
			offset: 1,
			limit: 1,
		});

		expect(listFiles).toHaveBeenCalledWith({
			repo: { type: 'model', name: 'org/repo' },
			path: 'weights',
			recursive: true,
			expand: true,
			accessToken: 'token',
		});
		expect(result).toEqual({
			uri: 'hf://models/org/repo/weights',
			op: 'ls',
			entries: [{ type: 'file', path: 'weights/c.gguf', size: 30 }],
		});
		expect(HF_FS_TOOL_CONFIG.outputSchema.parse(result)).toEqual(result);
	});

	it('marks ls results truncated when another matching entry exists', async () => {
		vi.mocked(listFiles).mockReturnValue(
			entries([
				{ type: 'file', path: 'a.txt', size: 1 },
				{ type: 'file', path: 'b.txt', size: 2 },
			])
		);

		const result = await new HfFsTool().run({
			op: 'ls',
			uri: 'hf://datasets/org/repo',
			limit: 1,
		});

		expect(result).toEqual({
			uri: 'hf://datasets/org/repo',
			op: 'ls',
			entries: [{ type: 'file', path: 'a.txt', size: 1 }],
			truncated: true,
			truncation_reason: 'entry_limit',
			truncation_message: 'Result truncated after reaching the entry limit. Resume with offset 1.',
			next_offset: 1,
		});
	});

	it('treats limit 0 as the maximum allowed list size', async () => {
		vi.mocked(listFiles).mockReturnValue(entries([{ type: 'file', path: 'a.txt', size: 1 }]));

		const result = await new HfFsTool().run({
			op: 'ls',
			uri: 'hf://datasets/org/repo',
			limit: 0,
		});

		expect(result).toEqual({
			uri: 'hf://datasets/org/repo',
			op: 'ls',
			entries: [{ type: 'file', path: 'a.txt', size: 1 }],
		});
	});

	it('keeps complete structured ls results while truncating the markdown view', async () => {
		vi.mocked(listFiles).mockReturnValue(
			entries(
				Array.from({ length: 100 }, (_, index) => ({
					type: 'file',
					path: `${index.toString().padStart(3, '0')}-${'nested/'.repeat(240)}file.txt`,
					size: index,
				}))
			)
		);

		const result = await new HfFsTool().run({
			op: 'ls',
			uri: 'hf://datasets/org/repo',
			limit: 100,
		});

		if (result.op !== 'ls') {
			throw new Error('Expected ls result');
		}
		expect(result.entries).toHaveLength(100);
		expect(result.truncated).toBeUndefined();
		const markdown = formatHfFsMarkdown(result);
		expect(markdown.length).toBeLessThanOrEqual(HF_FS_MAX_OUTPUT_CHARS);
		expect(markdown).toContain('Markdown view truncated');
	});

	it('lists model repositories for a namespace', async () => {
		vi.mocked(listModels).mockReturnValue(
			entries([
				{
					id: '1',
					name: 'openai/gpt-oss-120b',
					private: false,
					gated: false,
					task: 'text-generation',
					likes: 4937,
					downloads: 4_073_251,
					updatedAt: new Date('2025-08-26T17:25:03.000Z'),
				},
				{
					id: '2',
					name: 'openai/whisper-large-v3',
					private: false,
					gated: false,
					task: 'automatic-speech-recognition',
					likes: 5898,
					downloads: 5_778_052,
					updatedAt: new Date('2024-08-12T10:20:10.000Z'),
				},
			]) as ReturnType<typeof listModels>
		);

		const result = await new HfFsTool('token').run({
			op: 'ls',
			uri: 'hf://models/openai',
			glob: 'gpt-*',
		});

		expect(listModels).toHaveBeenCalledWith({
			search: { owner: 'openai' },
			sort: 'lastModified',
			accessToken: 'token',
		});
		expect(result).toEqual({
			uri: 'hf://models/openai',
			op: 'ls',
			entries: [
				{
					type: 'repo',
					path: 'openai/gpt-oss-120b',
					uri: 'hf://models/openai/gpt-oss-120b',
					repo_type: 'model',
					private: false,
					gated: false,
					likes: 4937,
					downloads: 4_073_251,
					task: 'text-generation',
					updated_at: '2025-08-26T17:25:03.000Z',
				},
			],
		});
	});

	it('keeps scanning namespace repositories before applying glob filters locally', async () => {
		vi.mocked(listModels).mockReturnValue(
			entries([
				{
					id: '1',
					name: 'org/recent-diffusion',
					private: false,
					gated: false,
					task: 'text-to-image',
					likes: 10,
					downloads: 20,
					updatedAt: new Date('2025-08-26T17:25:03.000Z'),
				},
				{
					id: '2',
					name: 'org/older-bert',
					private: false,
					gated: false,
					task: 'fill-mask',
					likes: 30,
					downloads: 40,
					updatedAt: new Date('2024-08-12T10:20:10.000Z'),
				},
			]) as ReturnType<typeof listModels>
		);

		const result = await new HfFsTool().run({
			op: 'ls',
			uri: 'hf://models/org',
			glob: '*bert*',
			limit: 1,
		});

		expect(listModels).toHaveBeenCalledWith({
			search: { owner: 'org' },
			sort: 'lastModified',
		});
		expect(result).toMatchObject({
			entries: [{ path: 'org/older-bert' }],
		});
	});

	it('limits namespace repository scans when no glob filter is applied', async () => {
		vi.mocked(listModels).mockReturnValue(entries([]) as ReturnType<typeof listModels>);

		await new HfFsTool().run({
			op: 'ls',
			uri: 'hf://models/org',
			offset: 3,
			limit: 5,
		});

		expect(listModels).toHaveBeenCalledWith({
			search: { owner: 'org' },
			sort: 'lastModified',
			limit: 9,
		});
	});

	it('lists buckets for a namespace', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(
				JSON.stringify([
					{
						_id: 'bucket-id',
						id: 'evalstate/skills',
						author: 'evalstate',
						private: false,
						createdAt: '2026-05-31T09:53:36.000Z',
						updatedAt: '2026-05-31T09:53:58.030Z',
						size: 4_527_050,
						totalFiles: 133,
						repoType: 'bucket',
						cdnRegions: [],
					},
				])
			)
		);

		const result = await new HfFsTool('token').run({
			op: 'ls',
			uri: 'hf://buckets/evalstate',
		});

		expect(fetch).toHaveBeenCalledWith(
			'https://huggingface.co/api/buckets/evalstate',
			expect.objectContaining({ redirect: 'manual' })
		);
		const bucketFetchInit = vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit;
		const bucketFetchHeaders = new Headers(bucketFetchInit.headers);
		expect(bucketFetchHeaders.get('accept')).toBe('application/json');
		expect(bucketFetchHeaders.get('authorization')).toBe('Bearer token');
		expect(result).toEqual({
			uri: 'hf://buckets/evalstate',
			op: 'ls',
			entries: [
				{
					type: 'bucket',
					path: 'evalstate/skills',
					uri: 'hf://buckets/evalstate/skills',
					repo_type: 'bucket',
					private: false,
					size: 4_527_050,
					total_files: 133,
					created_at: '2026-05-31T09:53:36.000Z',
					updated_at: '2026-05-31T09:53:58.030Z',
				},
			],
		});
	});

	it('defaults namespace listing to the authenticated user when omitted', async () => {
		vi.mocked(whoAmI).mockResolvedValueOnce({
			id: 'user-id',
			type: 'user',
			email: 'alice@example.com',
			emailVerified: true,
			isPro: false,
			orgs: [],
			name: 'alice',
			fullname: 'Alice',
			canPay: false,
			avatarUrl: '',
			periodEnd: null,
			billingMode: 'prepaid',
			auth: { type: 'access_token' },
		});
		vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify([])));

		await expect(new HfFsTool('token').run({ op: 'ls', uri: 'hf://buckets' })).resolves.toEqual({
			uri: 'hf://buckets',
			op: 'ls',
			entries: [],
		});
		expect(whoAmI).toHaveBeenCalledWith({ accessToken: 'token' });
		expect(fetch).toHaveBeenCalledWith(
			'https://huggingface.co/api/buckets/alice',
			expect.objectContaining({ redirect: 'manual' })
		);
	});

	it('requires authentication for omitted namespace listings', async () => {
		await expect(new HfFsTool().run({ op: 'ls', uri: 'hf://buckets' })).rejects.toThrow(
			'without an owner requires authentication'
		);
	});

	it('stats repo roots, files, directories, and missing paths', async () => {
		const tool = new HfFsTool();
		vi.mocked(spaceInfo).mockResolvedValueOnce(undefined as unknown as Awaited<ReturnType<typeof spaceInfo>>);

		await expect(tool.run({ op: 'stat', uri: 'hf://spaces/org/repo' })).resolves.toEqual({
			uri: 'hf://spaces/org/repo',
			op: 'stat',
			exists: true,
			type: 'repo',
			path: '',
		});

		vi.mocked(pathsInfo).mockResolvedValueOnce([{ path: 'README.md', type: 'file', size: 42 }]);
		await expect(tool.run({ op: 'stat', uri: 'hf://spaces/org/repo/README.md' })).resolves.toEqual({
			uri: 'hf://spaces/org/repo/README.md',
			op: 'stat',
			exists: true,
			type: 'file',
			path: 'README.md',
			size: 42,
		});

		vi.mocked(pathsInfo).mockResolvedValueOnce([{ path: 'data', type: 'directory', size: 0 }]);
		await expect(tool.run({ op: 'stat', uri: 'hf://datasets/org/repo/data' })).resolves.toMatchObject({
			exists: true,
			type: 'dir',
			path: 'data',
		});

		vi.mocked(pathsInfo).mockResolvedValueOnce([]);
		await expect(tool.run({ op: 'stat', uri: 'hf://datasets/org/repo/missing.txt' })).resolves.toEqual({
			uri: 'hf://datasets/org/repo/missing.txt',
			op: 'stat',
			exists: false,
			type: 'missing',
			path: 'missing.txt',
		});
	});

	it('probes repo roots before reporting them as existing', async () => {
		vi.mocked(modelInfo).mockResolvedValueOnce(undefined as unknown as Awaited<ReturnType<typeof modelInfo>>);

		await expect(new HfFsTool('token').run({ op: 'stat', uri: 'hf://models/org/repo' })).resolves.toEqual({
			uri: 'hf://models/org/repo',
			op: 'stat',
			exists: true,
			type: 'repo',
			path: '',
		});
		const modelInfoParams = vi.mocked(modelInfo).mock.calls[0]?.[0];
		expect(modelInfoParams).toMatchObject({
			name: 'org/repo',
			accessToken: 'token',
		});
		expect(typeof modelInfoParams?.fetch).toBe('function');
	});

	it('reports missing repo roots as missing', async () => {
		vi.mocked(modelInfo).mockRejectedValueOnce(new HubApiError('https://huggingface.co/api/models/org/missing', 404));

		await expect(new HfFsTool().run({ op: 'stat', uri: 'hf://models/org/missing' })).resolves.toEqual({
			uri: 'hf://models/org/missing',
			op: 'stat',
			exists: false,
			type: 'missing',
			path: '',
		});
	});

	it('reports repo roots with missing revisions as missing', async () => {
		vi.mocked(modelInfo).mockRejectedValueOnce(new HubApiError('https://huggingface.co/api/models/org/repo', 404));

		await expect(new HfFsTool().run({ op: 'stat', uri: 'hf://models/org/repo@missing-revision' })).resolves.toEqual({
			uri: 'hf://models/org/repo@missing-revision',
			op: 'stat',
			exists: false,
			type: 'missing',
			path: '',
		});
		const modelInfoParams = vi.mocked(modelInfo).mock.calls[0]?.[0];
		expect(modelInfoParams).toMatchObject({
			name: 'org/repo',
			revision: 'missing-revision',
		});
		expect(typeof modelInfoParams?.fetch).toBe('function');
	});

	it('reads exact file byte ranges for cat', async () => {
		vi.mocked(pathsInfo).mockResolvedValueOnce([{ path: 'README.md', type: 'file', size: 11 }]);
		vi.mocked(downloadFile).mockResolvedValueOnce(new Blob(['hello world']));

		const result = await new HfFsTool('token').run({
			op: 'cat',
			uri: 'hf://models/org/repo/README.md',
			offset: 6,
			max_bytes: 3,
		});

		expect(downloadFile).toHaveBeenCalledWith({
			repo: { type: 'model', name: 'org/repo' },
			path: 'README.md',
			accessToken: 'token',
		});
		expect(result).toEqual({
			uri: 'hf://models/org/repo/README.md',
			op: 'cat',
			path: 'README.md',
			content: 'wor',
			bytes: 3,
			truncated: true,
			truncation_reason: 'max_bytes',
			next_offset: 9,
		});
	});

	it('treats max_bytes 0 as the maximum allowed byte count', async () => {
		vi.mocked(pathsInfo).mockResolvedValueOnce([{ path: 'README.md', type: 'file', size: 11 }]);
		vi.mocked(downloadFile).mockResolvedValueOnce(new Blob(['hello world']));

		const result = await new HfFsTool().run({
			op: 'cat',
			uri: 'hf://models/org/repo/README.md',
			max_bytes: 0,
		});

		expect(result).toEqual({
			uri: 'hf://models/org/repo/README.md',
			op: 'cat',
			path: 'README.md',
			content: 'hello world',
			bytes: 11,
			truncated: false,
		});
	});

	it('extends cat ranges to avoid splitting trailing UTF-8 characters', async () => {
		vi.mocked(pathsInfo).mockResolvedValueOnce([{ path: 'unicode.txt', type: 'file', size: 5 }]);
		vi.mocked(downloadFile).mockResolvedValueOnce(new Blob(['a€b']));

		const result = await new HfFsTool().run({
			op: 'cat',
			uri: 'hf://models/org/repo/unicode.txt',
			max_bytes: 2,
		});

		expect(result).toEqual({
			uri: 'hf://models/org/repo/unicode.txt',
			op: 'cat',
			path: 'unicode.txt',
			content: 'a€',
			bytes: 4,
			truncated: true,
			truncation_reason: 'max_bytes',
			next_offset: 4,
		});
	});

	it('extends cat ranges to avoid splitting leading UTF-8 characters', async () => {
		vi.mocked(pathsInfo).mockResolvedValueOnce([{ path: 'unicode.txt', type: 'file', size: 5 }]);
		vi.mocked(downloadFile).mockResolvedValueOnce(new Blob(['a€b']));

		const result = await new HfFsTool().run({
			op: 'cat',
			uri: 'hf://models/org/repo/unicode.txt',
			offset: 2,
			max_bytes: 1,
		});

		expect(result).toEqual({
			uri: 'hf://models/org/repo/unicode.txt',
			op: 'cat',
			path: 'unicode.txt',
			content: '€',
			bytes: 3,
			truncated: true,
			truncation_reason: 'max_bytes',
			next_offset: 4,
		});
	});

	it('refuses to cat known binary file extensions before downloading', async () => {
		vi.mocked(pathsInfo).mockResolvedValueOnce([{ path: 'model.safetensors', type: 'file', size: 100 }]);

		await expect(
			new HfFsTool('token').run({
				op: 'cat',
				uri: 'hf://models/org/repo/model.safetensors',
			})
		).rejects.toThrow('Refusing to cat non-text file: model.safetensors');

		expect(downloadFile).not.toHaveBeenCalled();
	});

	it('refuses to cat unknown files containing NUL bytes', async () => {
		vi.mocked(pathsInfo).mockResolvedValueOnce([{ path: 'artifact.unknown', type: 'file', size: 5 }]);
		vi.mocked(downloadFile).mockResolvedValueOnce(new Blob([new Uint8Array([65, 0, 66, 67, 68])]));

		await expect(
			new HfFsTool('token').run({
				op: 'cat',
				uri: 'hf://models/org/repo/artifact.unknown',
			})
		).rejects.toThrow('contains NUL bytes');
	});

	it('refuses to cat unknown files that are not valid UTF-8 text', async () => {
		vi.mocked(pathsInfo).mockResolvedValueOnce([{ path: 'artifact.unknown', type: 'file', size: 3 }]);
		vi.mocked(downloadFile).mockResolvedValueOnce(new Blob([new Uint8Array([0xff, 0xfe, 0xfd])]));

		await expect(
			new HfFsTool('token').run({
				op: 'cat',
				uri: 'hf://models/org/repo/artifact.unknown',
			})
		).rejects.toThrow('not valid UTF-8 text');
	});

	it('cats unknown extensions when byte sniffing confirms UTF-8 text', async () => {
		vi.mocked(pathsInfo).mockResolvedValueOnce([{ path: 'modelcard.unknown', type: 'file', size: 12 }]);
		vi.mocked(downloadFile).mockResolvedValueOnce(new Blob(['hello\nworld\n']));

		const result = await new HfFsTool('token').run({
			op: 'cat',
			uri: 'hf://models/org/repo/modelcard.unknown',
		});

		expect(result).toEqual({
			uri: 'hf://models/org/repo/modelcard.unknown',
			op: 'cat',
			path: 'modelcard.unknown',
			content: 'hello\nworld\n',
			bytes: 12,
			truncated: false,
		});
	});

	it('keeps complete structured cat content while truncating the markdown view', async () => {
		vi.mocked(pathsInfo).mockResolvedValueOnce([{ path: 'large.txt', type: 'file', size: 120_000 }]);
		vi.mocked(downloadFile).mockResolvedValueOnce(new Blob(['x'.repeat(120_000)]));

		const result = await new HfFsTool().run({
			op: 'cat',
			uri: 'hf://models/org/repo/large.txt',
			max_bytes: 80_000,
		});

		if (result.op !== 'cat') {
			throw new Error('Expected cat result');
		}
		expect(result.truncated).toBe(true);
		expect(result.truncation_reason).toBe('max_bytes');
		expect(result.bytes).toBe(80_000);
		expect(result.content).toHaveLength(80_000);
		expect(result.next_offset).toBe(80_000);
		const markdown = formatHfFsMarkdown(result);
		expect(markdown.length).toBeLessThanOrEqual(HF_FS_MAX_OUTPUT_CHARS);
		expect(markdown).toContain('Markdown view truncated');
	});

	it('reports cat max-byte continuation offsets from the requested offset', async () => {
		vi.mocked(pathsInfo).mockResolvedValueOnce([{ path: 'large.txt', type: 'file', size: 120_050 }]);
		vi.mocked(downloadFile).mockResolvedValueOnce(new Blob(['x'.repeat(120_050)]));

		const result = await new HfFsTool().run({
			op: 'cat',
			uri: 'hf://models/org/repo/large.txt',
			offset: 50,
			max_bytes: 80_000,
		});

		if (result.op !== 'cat') {
			throw new Error('Expected cat result');
		}
		expect(result.truncated).toBe(true);
		expect(result.truncation_reason).toBe('max_bytes');
		expect(result.bytes).toBe(80_000);
		expect(result.next_offset).toBe(80_050);
	});
});
