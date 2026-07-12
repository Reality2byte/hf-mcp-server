import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HfFsTool, formatHfFsMarkdown } from './hf-fs.js';
import { HfFsPaperProvider, parsePaperUri } from './hf-fs-papers.js';
import type { HfFsParams, HfFsResult } from './hf-fs.js';

interface FetchRoute {
	path: string;
	search?: Record<string, string | null>;
	response: () => Response;
}

function json(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
		...init,
	});
}

function installFetchSimulator(routes: FetchRoute[]): ReturnType<typeof vi.fn> {
	const simulator = vi.fn(async (input: RequestInfo | URL) => {
		await Promise.resolve();
		const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
		const route = routes.find(({ path, search }) => {
			if (url.pathname !== path) {
				return false;
			}
			return Object.entries(search ?? {}).every(([key, value]) => url.searchParams.get(key) === value);
		});
		if (!route) {
			throw new Error(`Unexpected fetch: ${url.toString()}`);
		}
		return route.response();
	});
	vi.stubGlobal('fetch', simulator);
	return simulator;
}

const paper = {
	id: '2401.00001',
	title: 'A Useful Paper',
	summary: 'The original abstract.',
	ai_summary: 'A generated summary.',
	upvotes: 42,
	publishedAt: '2024-01-02T00:00:00.000Z',
	submittedOnDailyAt: '2024-01-03T00:00:00.000Z',
	authors: [
		{ name: 'Ada Lovelace', hidden: false },
		{ name: 'Hidden Author', hidden: true },
	],
	projectPage: 'https://example.com/project',
	githubRepo: 'https://github.com/example/paper',
	numTotalModels: 1,
	numTotalDatasets: 1,
	numTotalSpaces: 1,
};

const linkedRepos = {
	models: [
		{
			id: 'google/gemma',
			lastModified: '2026-07-01T12:00:00.000Z',
			private: false,
			downloads: 1_200_000,
			likes: 842,
			tags: ['arxiv:2401.00001'],
			pipeline_tag: 'text-generation',
			library_name: 'transformers',
		},
	],
	datasets: [
		{
			id: 'openai/gsm8k',
			lastModified: '2026-06-01T12:00:00.000Z',
			private: false,
			downloads: 20_000,
			likes: 100,
			tags: ['arxiv:2401.00001'],
		},
	],
	spaces: [
		{
			id: 'huggingface/agents-course',
			lastModified: '2026-05-01T12:00:00.000Z',
			private: false,
			likes: 50,
			trendingScore: 12.5,
			sdk: 'gradio',
			tags: ['arxiv:2401.00001'],
		},
	],
};

describe('parsePaperUri', () => {
	it('normalizes arXiv IDs and canonicalizes linked paths', () => {
		expect(parsePaperUri('hf://papers/2406.105/')).toEqual({
			kind: 'paper',
			uri: 'hf://papers/2406.00105',
			paperId: '2406.00105',
			path: '',
		});
		expect(parsePaperUri('hf://papers/1401.1234/models/google/gemma/file%20name.txt')).toEqual({
			kind: 'paper-linked-item',
			uri: 'hf://papers/1401.1234/models/google/gemma/file%20name.txt',
			paperId: '1401.1234',
			target: 'models',
			namespace: 'google',
			name: 'gemma',
			remainder: 'file name.txt',
		});
	});

	it('parses roots, guidance, and linked namespaces', () => {
		expect(parsePaperUri('hf://papers')).toEqual({ kind: 'papers-root', uri: 'hf://papers' });
		expect(parsePaperUri('hf://papers/README.md')).toEqual({
			kind: 'papers-readme',
			uri: 'hf://papers/README.md',
		});
		expect(parsePaperUri('hf://papers/trending')).toEqual({
			kind: 'papers-trending',
			uri: 'hf://papers/trending',
		});
		expect(parsePaperUri('hf://papers/daily/2026/07/10')).toEqual({
			kind: 'papers-daily-day',
			uri: 'hf://papers/daily/2026/07/10',
			year: 2026,
			month: 7,
			day: 10,
			date: '2026-07-10',
		});
		expect(parsePaperUri('hf://papers/2401.00001/datasets/openai')).toMatchObject({
			kind: 'paper-linked-namespace',
			target: 'datasets',
			namespace: 'openai',
		});
	});

	it('rejects invalid paper IDs and paths', () => {
		expect(() => parsePaperUri('hf://papers/not-an-id')).toThrow('EINVAL: invalid arXiv paper id');
		expect(() => parsePaperUri('hf://papers/2401.12')).toThrow('EINVAL: invalid arXiv paper id');
		expect(() => parsePaperUri('hf://papers/2401.00001/collections')).toThrow('ENOENT');
		expect(() => parsePaperUri('hf://papers/daily/2026/02/30')).toThrow('invalid Daily Papers date');
	});
});

describe('papers guidance and Daily Papers', () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
	});

	it('lists and reads root and papers guidance', async () => {
		const tool = new HfFsTool();
		const root = await tool.run({ op: 'ls', uri: 'hf://' });
		expect(root).toMatchObject({
			op: 'ls',
			entries: [
				{ path: 'README.md', uri: 'hf://README.md' },
				{ path: 'models' },
				{ path: 'datasets' },
				{ path: 'spaces' },
				{ path: 'buckets' },
				{ path: 'collections' },
				{ path: 'papers' },
			],
		});

		const rootReadme = await tool.run({ op: 'cat', uri: 'hf://README.md', max_bytes: 30 });
		expect(rootReadme).toMatchObject({
			op: 'cat',
			content_type: 'text/markdown',
			bytes: 30,
			truncated: true,
			next_offset: 30,
		});
		const papersReadme = await tool.run({ op: 'cat', uri: 'hf://papers/README.md' });
		expect(papersReadme).toMatchObject({ op: 'cat', content_type: 'text/markdown', truncated: false });
		if (papersReadme.op !== 'cat') {
			throw new Error('Expected cat result');
		}
		expect(papersReadme.content).toContain('hf://papers/2502.16161/paper.md');
		await expect(tool.run({ op: 'ls', uri: 'hf://README.md' })).rejects.toThrow('ENOTDIR');
		await expect(tool.run({ op: 'search', uri: 'hf://papers/README.md', query: 'attention' })).rejects.toThrow(
			'ENOTDIR'
		);
	});

	it('lists the bounded Papers namespace and advertises direct paper lookup', async () => {
		const fetchSimulator = installFetchSimulator([
			{
				path: '/api/daily_papers',
				search: { p: '0', limit: '2', sort: 'publishedAt' },
				response: () => json([{ paper }, { paper: { ...paper, id: '2401.00002' } }]),
			},
		]);
		const result = await new HfFsTool('token').run({ op: 'ls', uri: 'hf://papers', limit: 2 });
		expect(result).toMatchObject({
			uri: 'hf://papers',
			op: 'ls',
			entries: [
				{
					type: 'file',
					name: 'README.md',
					path: 'README.md',
					uri: 'hf://papers/README.md',
					title: 'How to use Hugging Face Papers',
					description:
						'Search globally or inspect a paper directly as hf://papers/ARXIV_ID, for example hf://papers/2502.16161/paper.md.',
					content_type: 'text/markdown',
				},
				{
					type: 'dir',
					name: 'daily',
					path: 'daily',
					uri: 'hf://papers/daily',
					description: 'Browse Daily Papers batches from 2023-05-04, including daily/latest.',
				},
				{
					type: 'dir',
					name: 'trending',
					path: 'trending',
					uri: 'hf://papers/trending',
					description: 'Current opaque Hugging Face global trending ranking.',
				},
				{ type: 'paper', uri: 'hf://papers/2401.00001' },
				{ type: 'paper', uri: 'hf://papers/2401.00002' },
			],
			truncated: true,
			truncation_reason: 'provider_limit',
			truncation_message:
				'Showing 2 recent papers. The complete paper namespace is not enumerable; use search hf://papers to discover papers by topic or inspect hf://papers/ARXIV_ID directly.',
		});
		expect(fetchSimulator).toHaveBeenCalledTimes(1);
		expect(formatHfFsMarkdown(result)).toContain('hf://papers/2502.16161/paper.md');
		expect(formatHfFsMarkdown(result)).toContain('Showing 2 recent papers');
	});

	it('lists trending explicitly and rejects sorting or recursive traversal on the provider root', async () => {
		installFetchSimulator([
			{
				path: '/api/daily_papers',
				search: { p: '0', limit: '100', sort: 'trending' },
				response: () => json([]),
			},
		]);
		const tool = new HfFsTool();
		const result = await tool.run({ op: 'ls', uri: 'hf://papers/trending', limit: 10_000 });
		expect(formatHfFsMarkdown(result)).toContain('Order: Hugging Face global trending rank');
		await expect(tool.run({ op: 'ls', uri: 'hf://papers', sort: 'downloads' })).rejects.toThrow(
			'sort is not supported on hf://papers'
		);
		await expect(tool.run({ op: 'ls', uri: 'hf://papers', recursive: true })).rejects.toThrow(
			'recursive ls is not supported on hf://papers'
		);
		await expect(tool.run({ op: 'find', uri: 'hf://papers' })).rejects.toThrow('find is not supported on hf://papers');
	});

	it('synthesizes bounded Daily Papers directories and lists a stable dated batch', async () => {
		installFetchSimulator([
			{
				path: '/api/daily_papers',
				search: { p: '0', limit: '100', date: '2024-01-03', sort: 'publishedAt' },
				response: () => json([{ paper }]),
			},
		]);
		const tool = new HfFsTool();
		const dailyRoot = await tool.run({ op: 'ls', uri: 'hf://papers/daily' });
		if (dailyRoot.op !== 'ls') {
			throw new Error('Expected ls result');
		}
		expect(dailyRoot.entries[0]).toMatchObject({
			path: 'latest',
			uri: 'hf://papers/daily/latest',
		});
		expect(dailyRoot.entries[0]?.target_uri).toMatch(/^hf:\/\/papers\/daily\/\d{4}\/\d{2}\/\d{2}$/);
		expect(dailyRoot.entries[0]?.daily_papers_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(dailyRoot.entries[1]?.path).toBe('2023');
		const firstYear = await tool.run({ op: 'ls', uri: 'hf://papers/daily/2023' });
		expect(firstYear.op === 'ls' && firstYear.entries[0]?.path).toBe('05');
		const firstMonth = await tool.run({ op: 'ls', uri: 'hf://papers/daily/2023/05' });
		expect(firstMonth.op === 'ls' && firstMonth.entries[0]?.path).toBe('04');
		await expect(tool.run({ op: 'ls', uri: 'hf://papers/daily/2023/05/03' })).rejects.toThrow('predates the archive');
		const year = await tool.run({ op: 'ls', uri: 'hf://papers/daily/2024' });
		expect(year.op === 'ls' && year.entries.map((entry) => entry.path)).toEqual([
			'01',
			'02',
			'03',
			'04',
			'05',
			'06',
			'07',
			'08',
			'09',
			'10',
			'11',
			'12',
		]);
		const month = await tool.run({ op: 'ls', uri: 'hf://papers/daily/2024/01', glob: '0[1-3]' });
		expect(month).toMatchObject({ entries: [{ path: '01' }, { path: '02' }, { path: '03' }] });
		const day = await tool.run({ op: 'ls', uri: 'hf://papers/daily/2024/01/03' });
		expect(day).toMatchObject({
			entries: [
				{
					uri: 'hf://papers/2401.00001',
					daily_papers_date: '2024-01-03',
					daily_papers_uri: 'hf://papers/daily/2024/01/03',
				},
			],
		});
		expect(formatHfFsMarkdown(day)).toContain('Order: Daily Papers batch upvotes, then feed placement');
	});

	it('exposes latest as a dated alias and keeps trending recursion at the index edge', async () => {
		const fetchSimulator = installFetchSimulator([
			{
				path: '/api/daily_papers',
				search: { p: '0', limit: '1', sort: 'publishedAt' },
				response: () => json([{ paper }]),
			},
			{
				path: '/api/daily_papers',
				search: { p: '0', limit: '2', sort: 'trending' },
				response: () => json([{ paper }, { paper: { ...paper, id: '2401.00002' } }]),
			},
		]);
		const tool = new HfFsTool();
		const latestStat = await tool.run({ op: 'stat', uri: 'hf://papers/daily/latest' });
		if (latestStat.op !== 'stat') {
			throw new Error('Expected stat result');
		}
		expect(latestStat.type).toBe('dir');
		expect(latestStat.target_uri).toMatch(/^hf:\/\/papers\/daily\/\d{4}\/\d{2}\/\d{2}$/);
		expect(latestStat.daily_papers_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		await tool.run({ op: 'ls', uri: 'hf://papers/daily/latest', limit: 1 });
		const trending = await tool.run({ op: 'ls', uri: 'hf://papers/trending', recursive: true, limit: 2 });
		if (trending.op !== 'ls') {
			throw new Error('Expected ls result');
		}
		expect(trending.entries.map((entry) => [entry.type, entry.uri])).toEqual([
			['paper', 'hf://papers/2401.00001'],
			['paper', 'hf://papers/2401.00002'],
		]);
		expect(trending.entries.every((entry) => typeof entry.observed_at === 'string')).toBe(true);
		expect(fetchSimulator).toHaveBeenCalledTimes(2);
	});

	it('rejects zero and negative limits', async () => {
		const tool = new HfFsTool();
		await expect(tool.run({ op: 'ls', uri: 'hf://papers', limit: 0 })).rejects.toThrow(
			'EINVAL: limit must be an integer between 1 and 10000'
		);
		await expect(tool.run({ op: 'search', uri: 'hf://papers', query: 'attention', limit: -1 })).rejects.toThrow(
			'EINVAL: limit must be an integer between 1 and 10000'
		);
	});
});

describe('paper search and files', () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
	});

	it('searches indexed papers, applies the local limit, and emits canonical paper entries', async () => {
		installFetchSimulator([
			{
				path: '/api/papers/search',
				search: { q: 'attention', limit: null },
				response: () =>
					json([{ paper: { ...paper, id: '2406.105' } }, { paper: { ...paper, id: '2401.00001', title: 'Second' } }]),
			},
		]);
		const result = await new HfFsTool().run({
			op: 'search',
			uri: 'hf://papers',
			query: 'attention',
			limit: 1,
		});
		expect(result).toMatchObject({
			uri: 'hf://papers',
			op: 'search',
			entries: [{ type: 'paper', uri: 'hf://papers/2406.00105', description: 'A generated summary.' }],
			truncated: true,
			truncation_reason: 'limit',
		});
		expect('next_cursor' in result).toBe(false);
		const markdown = formatHfFsMarkdown(result);
		expect(markdown).toContain('summary=A generated summary.');
		expect(markdown).toContain('published=2024-01-02T00:00:00.000Z');
		expect(markdown).toContain('daily papers uri=hf://papers/daily/2024/01/03');
	});

	it('stats papers and lists their fixed children without collections', async () => {
		installFetchSimulator([
			{ path: '/api/papers/2401.00001', response: () => json(paper) },
			{ path: '/api/papers/2401.00002', response: () => json({}, { status: 404 }) },
		]);
		const tool = new HfFsTool();
		const stat = await tool.run({ op: 'stat', uri: 'hf://papers/2401.00001' });
		expect(stat).toEqual({
			uri: 'hf://papers/2401.00001',
			op: 'stat',
			exists: true,
			type: 'paper',
			path: '2401.00001',
			published_at: '2024-01-02T00:00:00.000Z',
			daily_papers_date: '2024-01-03',
			daily_papers_uri: 'hf://papers/daily/2024/01/03',
			url: 'https://huggingface.co/papers/2401.00001',
			arxiv_url: 'https://arxiv.org/abs/2401.00001',
		});
		const statMarkdown = formatHfFsMarkdown(stat);
		expect(statMarkdown).toContain('Published: 2024-01-02T00:00:00.000Z');
		expect(statMarkdown).toContain('Daily Papers date: 2024-01-03');
		await expect(tool.run({ op: 'stat', uri: 'hf://papers/2401.00002' })).resolves.toEqual({
			uri: 'hf://papers/2401.00002',
			op: 'stat',
			exists: false,
			type: 'missing',
			path: '2401.00002',
		});
		const ls = await tool.run({ op: 'ls', uri: 'hf://papers/2401.00001' });
		expect(ls).toMatchObject({
			entries: [
				{ path: 'metadata.json' },
				{ path: 'paper.md' },
				{ path: 'models' },
				{ path: 'datasets' },
				{ path: 'spaces' },
			],
		});
		if (ls.op !== 'ls') {
			throw new Error('Expected ls result');
		}
		expect(ls.entries.some((entry) => entry.path === 'collections')).toBe(false);
	});

	it('returns pretty metadata JSON with byte truncation', async () => {
		installFetchSimulator([{ path: '/api/papers/2401.00001', response: () => json(paper) }]);
		const result = await new HfFsTool().run({
			op: 'cat',
			uri: 'hf://papers/2401.00001/metadata.json',
			max_bytes: 40,
		});
		expect(result).toMatchObject({
			op: 'cat',
			path: 'metadata.json',
			content_type: 'application/json',
			bytes: 40,
			truncated: true,
			next_offset: 40,
		});
	});

	it('returns converted full Markdown when available', async () => {
		installFetchSimulator([
			{ path: '/api/papers/2401.00001', response: () => json(paper) },
			{
				path: '/papers/2401.00001.md',
				response: () => new Response('# Full paper\n\nSource text.', { status: 200 }),
			},
		]);
		const result = await new HfFsTool().run({ op: 'cat', uri: 'hf://papers/2401.00001/paper.md' });
		expect(result).toMatchObject({
			op: 'cat',
			content: '# Full paper\n\nSource text.',
			content_type: 'text/markdown',
			truncated: false,
		});
	});

	it('synthesizes a labelled fallback without presenting the AI summary as source text', async () => {
		installFetchSimulator([
			{ path: '/api/papers/2401.00001', response: () => json(paper) },
			{ path: '/papers/2401.00001.md', response: () => new Response('missing', { status: 404 }) },
		]);
		const result = await new HfFsTool().run({ op: 'cat', uri: 'hf://papers/2401.00001/paper.md' });
		if (result.op !== 'cat') {
			throw new Error('Expected cat result');
		}
		expect(result.content).toContain('> **Full-text availability:**');
		expect(result.content).toContain('[original PDF](https://arxiv.org/pdf/2401.00001)');
		expect(result.content).toContain('## AI-generated summary');
		expect(result.content).toContain('may contain inaccuracies');
		expect(result.content).toContain('## Abstract\n\nThe original abstract.');
		expect(result.content).toContain('Ada Lovelace');
		expect(result.content).not.toContain('Hidden Author');
		expect(result.content).toContain('[Project page](https://example.com/project)');
		expect(result.content).toContain('[GitHub repository](https://github.com/example/paper)');
	});

	it('stats paper.md without probing full-text availability', async () => {
		const fetchSimulator = installFetchSimulator([{ path: '/api/papers/2401.00001', response: () => json(paper) }]);
		await expect(new HfFsTool().run({ op: 'stat', uri: 'hf://papers/2401.00001/paper.md' })).resolves.toMatchObject({
			exists: true,
			type: 'file',
			content_type: 'text/markdown',
		});
		expect(fetchSimulator).toHaveBeenCalledTimes(1);
	});
});

describe('paper-linked repositories', () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
	});

	it('groups deterministic links and preserves provider metadata', async () => {
		installFetchSimulator([
			{ path: '/api/papers/2401.00001', response: () => json(paper) },
			{ path: '/api/arxiv/2401.00001/repos', response: () => json(linkedRepos) },
		]);
		const provider = new HfFsPaperProvider();
		const models = await provider.run({ op: 'ls', uri: 'hf://papers/2401.00001/models/google' });
		expect(models).toEqual({
			uri: 'hf://papers/2401.00001/models/google',
			op: 'ls',
			entries: [
				{
					type: 'link',
					name: 'gemma',
					path: 'models/google/gemma',
					uri: 'hf://papers/2401.00001/models/google/gemma',
					target_uri: 'hf://models/google/gemma',
					title: 'google/gemma',
					private: false,
					likes: 842,
					downloads: 1_200_000,
					task: 'text-generation',
					library: 'transformers',
					tags: ['arxiv:2401.00001'],
					updated_at: '2026-07-01T12:00:00.000Z',
				},
			],
		});
		const spaces = await provider.run({ op: 'ls', uri: 'hf://papers/2401.00001/spaces/huggingface' });
		expect(spaces).toMatchObject({
			entries: [
				{
					target_uri: 'hf://spaces/huggingface/agents-course',
					likes: 50,
					trending_score: 12.5,
					sdk: 'gradio',
				},
			],
		});
		if (spaces.op !== 'ls') {
			throw new Error('Expected ls result');
		}
		expect(spaces.entries[0]).not.toHaveProperty('downloads');
		expect(spaces.entries[0]).not.toHaveProperty('target_type');
		expect(spaces.entries[0]).not.toHaveProperty('repo_type');
	});

	it('marks bounded linked results as provider-truncated', async () => {
		installFetchSimulator([
			{
				path: '/api/papers/2401.00001',
				response: () => json({ ...paper, numTotalModels: 101 }),
			},
			{ path: '/api/arxiv/2401.00001/repos', response: () => json(linkedRepos) },
		]);
		await expect(
			new HfFsPaperProvider().run({ op: 'ls', uri: 'hf://papers/2401.00001/models' })
		).resolves.toMatchObject({
			truncated: true,
			truncation_reason: 'provider_limit',
		});
	});

	it('inspects exact links but resolves explicit child operations to canonical targets', async () => {
		installFetchSimulator([
			{ path: '/api/papers/2401.00001', response: () => json(paper) },
			{ path: '/api/arxiv/2401.00001/repos', response: () => json(linkedRepos) },
		]);
		const targetRunner = vi.fn(async (params: HfFsParams): Promise<HfFsResult> => {
			await Promise.resolve();
			return {
				uri: params.uri,
				op: 'cat',
				path: 'README.md',
				content: 'canonical target content',
				bytes: 24,
				truncated: false,
			};
		});
		const provider = new HfFsPaperProvider(undefined, undefined, targetRunner);
		await expect(provider.run({ op: 'stat', uri: 'hf://papers/2401.00001/models/google/gemma' })).resolves.toEqual({
			uri: 'hf://papers/2401.00001/models/google/gemma',
			op: 'stat',
			exists: true,
			type: 'link',
			path: 'models/google/gemma',
			target_uri: 'hf://models/google/gemma',
		});
		expect(targetRunner).not.toHaveBeenCalled();

		const result = await provider.run({
			op: 'cat',
			uri: 'hf://papers/2401.00001/models/google/gemma/README.md',
		});
		expect(targetRunner).toHaveBeenCalledWith({
			op: 'cat',
			uri: 'hf://models/google/gemma/README.md',
		});
		expect(result).toMatchObject({ uri: 'hf://models/google/gemma/README.md' });
	});

	it('rejects unrelated repositories when the bounded result is complete', async () => {
		installFetchSimulator([
			{ path: '/api/papers/2401.00001', response: () => json(paper) },
			{ path: '/api/arxiv/2401.00001/repos', response: () => json(linkedRepos) },
		]);
		await expect(
			new HfFsPaperProvider().run({
				op: 'ls',
				uri: 'hf://papers/2401.00001/models/unrelated/repo',
			})
		).rejects.toThrow('ENOENT: linked repository not found for this paper');
	});

	it('verifies a direct relationship beyond the bounded result before resolving', async () => {
		installFetchSimulator([
			{
				path: '/api/papers/2401.00001',
				response: () => json({ ...paper, numTotalModels: 101 }),
			},
			{ path: '/api/arxiv/2401.00001/repos', response: () => json(linkedRepos) },
			{
				path: '/api/models/beyond/repo/revision/HEAD',
				response: () =>
					json({
						_id: 'model-id',
						id: 'beyond/repo',
						private: false,
						gated: false,
						downloads: 1,
						likes: 2,
						lastModified: '2026-07-01T00:00:00.000Z',
						pipeline_tag: 'text-generation',
						tags: ['arxiv:2401.00001'],
					}),
			},
		]);
		const targetRunner = vi.fn(async (params: HfFsParams): Promise<HfFsResult> => {
			await Promise.resolve();
			return { uri: params.uri, op: 'ls', entries: [] };
		});
		const provider = new HfFsPaperProvider(undefined, undefined, targetRunner);
		const result = await provider.run({
			op: 'ls',
			uri: 'hf://papers/2401.00001/models/beyond/repo',
		});
		expect(targetRunner).toHaveBeenCalledWith({
			op: 'ls',
			uri: 'hf://models/beyond/repo',
		});
		expect(result).toEqual({ uri: 'hf://models/beyond/repo', op: 'ls', entries: [] });
	});

	it('returns canonical guidance instead of a false ENOENT when a bounded relationship is unverifiable', async () => {
		installFetchSimulator([
			{
				path: '/api/papers/2401.00001',
				response: () => json({ ...paper, numTotalModels: 101 }),
			},
			{ path: '/api/arxiv/2401.00001/repos', response: () => json(linkedRepos) },
			{
				path: '/api/models/beyond/repo/revision/HEAD',
				response: () =>
					json({
						_id: 'model-id',
						id: 'beyond/repo',
						private: false,
						gated: false,
						downloads: 1,
						likes: 2,
						lastModified: '2026-07-01T00:00:00.000Z',
						pipeline_tag: 'text-generation',
						tags: [],
					}),
			},
		]);
		await expect(
			new HfFsPaperProvider().run({
				op: 'ls',
				uri: 'hf://papers/2401.00001/models/beyond/repo',
			})
		).rejects.toThrow('ENOTSUP: linked relationship is outside the bounded paper result; use hf://models/beyond/repo');
	});

	it('traverses local containment without following links', async () => {
		const fetchSimulator = installFetchSimulator([
			{ path: '/api/papers/2401.00001', response: () => json(paper) },
			{ path: '/api/arxiv/2401.00001/repos', response: () => json(linkedRepos) },
		]);
		const targetRunner = vi.fn();
		const provider = new HfFsPaperProvider(undefined, undefined, targetRunner);
		const result = await provider.run({
			op: 'find',
			uri: 'hf://papers/2401.00001',
			entry_type: 'link',
			name: '*gemma*',
		});
		expect(result).toMatchObject({
			op: 'find',
			entries: [{ path: 'models/google/gemma', target_uri: 'hf://models/google/gemma' }],
		});
		if (result.op !== 'find') {
			throw new Error('Expected find result');
		}
		expect(result.entries.map((entry) => entry.path)).toEqual(['models/google/gemma']);
		expect(targetRunner).not.toHaveBeenCalled();
		expect(fetchSimulator).toHaveBeenCalledTimes(2);
		const markdown = formatHfFsMarkdown(result);
		expect(markdown).toContain(
			'| link | models/google/gemma | hf://papers/2401.00001/models/google/gemma | hf://models/google/gemma |'
		);
		expect(markdown.match(/Links resolve during direct operations/g)).toHaveLength(1);
	});
});
