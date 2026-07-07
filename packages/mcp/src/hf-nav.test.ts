import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HfNavTool, formatHfNavMarkdown, parseHfNavUri } from './hf-nav.js';

function jsonResponse(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
		...init,
	});
}

function lastFetchUrl(): URL {
	const calls = vi.mocked(fetch).mock.calls;
	const input = calls[calls.length - 1]?.[0];
	if (typeof input !== 'string') {
		throw new Error('Expected string fetch URL');
	}
	return new URL(input);
}

describe('parseHfNavUri', () => {
	it('accepts canonical collection paths and trailing slashes', () => {
		expect(parseHfNavUri('hf://')).toMatchObject({ kind: 'root', uri: 'hf://' });
		expect(parseHfNavUri('hf:///')).toMatchObject({ kind: 'root', uri: 'hf://' });
		expect(parseHfNavUri('hf://collections')).toMatchObject({ kind: 'collections-root' });
		expect(parseHfNavUri('hf://collections/huggingface/')).toMatchObject({
			kind: 'collection-owner',
			owner: 'huggingface',
			uri: 'hf://collections/huggingface',
		});
		expect(parseHfNavUri('hf://collections/huggingface/foo-0123456789abcdef01234567')).toMatchObject({
			kind: 'collection',
			owner: 'huggingface',
			slug: 'foo-0123456789abcdef01234567',
		});
		expect(
			parseHfNavUri('hf://collections/huggingface/foo-0123456789abcdef01234567/items/000-model-google-gemma')
		).toMatchObject({
			kind: 'collection-item',
			owner: 'huggingface',
			slug: 'foo-0123456789abcdef01234567',
			item: '000-model-google-gemma',
		});
	});

	it('rejects invalid URI forms', () => {
		expect(() => parseHfNavUri('https://huggingface.co/collections')).toThrow('EINVAL: URI must start with hf://');
		expect(() => parseHfNavUri('hf://collections//huggingface')).toThrow(
			'EINVAL: URI path must not contain empty segments'
		);
		expect(() => parseHfNavUri('hf://collections/%E0%A4%A')).toThrow(
			'EINVAL: invalid percent-encoding in URI segment'
		);
	});
});

describe('HfNavTool', () => {
	beforeEach(() => {
		vi.stubGlobal('fetch', vi.fn());
	});

	it('lists the static root', async () => {
		const result = await new HfNavTool().run({ op: 'ls', uri: 'hf://' });

		expect(result).toEqual({
			uri: 'hf://',
			op: 'ls',
			entries: [{ type: 'dir', name: 'collections', path: 'collections', uri: 'hf://collections' }],
		});
	});

	it('lists owner collections using compact collection API responses', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			jsonResponse([
				{
					name: 'huggingface/agents-course-0123456789abcdef01234567',
					title: 'Agents Course',
					private: false,
					upvotes: 123,
				},
			])
		);

		const result = await new HfNavTool('token').run({
			op: 'ls',
			uri: 'hf://collections/huggingface',
			limit: 20,
		});

		const url = lastFetchUrl();
		expect(url.pathname).toBe('/api/collections');
		expect(url.searchParams.get('owner')).toBe('huggingface');
		expect(url.searchParams.get('expand')).toBe('false');
		expect(url.searchParams.get('limit')).toBe('20');
		const headers = vi.mocked(fetch).mock.calls[0]?.[1]?.headers;
		expect(headers instanceof Headers ? headers.get('authorization') : undefined).toBe('Bearer token');
		expect(result).toEqual({
			uri: 'hf://collections/huggingface',
			op: 'ls',
			entries: [
				{
					type: 'collection',
					name: 'agents-course-0123456789abcdef01234567',
					path: 'agents-course-0123456789abcdef01234567',
					uri: 'hf://collections/huggingface/agents-course-0123456789abcdef01234567',
					title: 'Agents Course',
					private: false,
					upvotes: 123,
				},
			],
		});
	});

	it('searches owner collections with q and sort params', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			jsonResponse([{ name: 'agents-course-0123456789abcdef01234567', title: 'Agents Course' }])
		);

		const result = await new HfNavTool().run({
			op: 'search',
			uri: 'hf://collections/huggingface',
			query: 'agents',
			sort: 'upvotes',
			limit: 5,
		});

		const url = lastFetchUrl();
		expect(url.searchParams.get('owner')).toBe('huggingface');
		expect(url.searchParams.get('q')).toBe('agents');
		expect(url.searchParams.get('sort')).toBe('upvotes');
		expect(url.searchParams.get('expand')).toBe('false');
		if (result.op !== 'search') {
			throw new Error('Expected search result');
		}
		expect(result.entries[0]?.uri).toBe('hf://collections/huggingface/agents-course-0123456789abcdef01234567');
	});

	it('cats metadata and maps collection items to link entries', async () => {
		const collection = {
			slug: 'agents-course-0123456789abcdef01234567',
			title: 'Agents Course',
			owner: { name: 'huggingface' },
			private: false,
			upvotes: 123,
			items: [
				{ type: 'dataset', id: 'openai/gsm8k', position: 1 },
				{ type: 'model', id: 'google/gemma-2-2b', position: 0 },
				{
					type: 'collection',
					slug: 'evalstate/related-work-0123456789abcdef01234567',
					owner: { name: 'evalstate' },
					position: 2,
					title: 'Related Work',
				},
			],
		};
		vi.mocked(fetch)
			.mockResolvedValueOnce(jsonResponse(collection))
			.mockResolvedValueOnce(jsonResponse(collection))
			.mockResolvedValueOnce(jsonResponse(collection));

		const cat = await new HfNavTool().run({
			op: 'cat',
			uri: 'hf://collections/huggingface/agents-course-0123456789abcdef01234567/metadata.json',
		});
		if (cat.op !== 'cat') {
			throw new Error('Expected cat result');
		}
		expect(cat.content).toContain('"Agents Course"');

		const ls = await new HfNavTool().run({
			op: 'ls',
			uri: 'hf://collections/huggingface/agents-course-0123456789abcdef01234567/items',
		});
		if (ls.op !== 'ls') {
			throw new Error('Expected ls result');
		}
		expect(ls.entries.map((entry) => [entry.name, entry.target_uri, entry.repo_type])).toEqual([
			['000-model-google-gemma-2-2b', 'hf://models/google/gemma-2-2b', 'model'],
			['001-dataset-openai-gsm8k', 'hf://datasets/openai/gsm8k', 'dataset'],
			[
				'002-collection-evalstate-related-work-0123456789abcdef01234567',
				'hf://collections/evalstate/related-work-0123456789abcdef01234567',
				undefined,
			],
		]);
		expect(ls.entries[0]?.uri).toBe(
			'hf://collections/huggingface/agents-course-0123456789abcdef01234567/items/000-model-google-gemma-2-2b'
		);
		expect(formatHfNavMarkdown(ls)).toContain(
			'| l | 000-model-google-gemma-2-2b | hf://models/google/gemma-2-2b | title=google/gemma-2-2b |'
		);

		const stat = await new HfNavTool().run({
			op: 'stat',
			uri: ls.entries[0]?.uri ?? '',
		});
		expect(stat).toMatchObject({
			op: 'stat',
			exists: true,
			type: 'link',
			path: 'huggingface/agents-course-0123456789abcdef01234567/items/000-model-google-gemma-2-2b',
		});
	});

	it('finds model item links without following targets', async () => {
		vi.mocked(fetch)
			.mockResolvedValueOnce(
				jsonResponse([{ name: 'llama-set-0123456789abcdef01234567', title: 'Llama Set' }])
			)
			.mockResolvedValueOnce(
				jsonResponse({
					slug: 'llama-set-0123456789abcdef01234567',
					owner: { name: 'unsloth' },
					items: [
						{ type: 'model', id: 'meta-llama/Llama-3.1-8B', position: 0 },
						{ type: 'dataset', id: 'openai/gsm8k', position: 1 },
						{
							type: 'collection',
							slug: 'related-work-0123456789abcdef01234567',
							owner: { name: 'evalstate' },
							position: 2,
							title: 'Related Work',
						},
					],
				})
			);

		const result = await new HfNavTool().run({
			op: 'find',
			uri: 'hf://collections/unsloth',
			path: '*/items/*llama*',
			type: 'link',
			target_type: 'repo',
			repo_type: 'model',
			max_depth: 3,
		});

		if (result.op !== 'find') {
			throw new Error('Expected find result');
		}
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]).toMatchObject({
			path: 'llama-set-0123456789abcdef01234567/items/000-model-meta-llama-Llama-3.1-8B',
			target_uri: 'hf://models/meta-llama/Llama-3.1-8B',
		});
		expect(result.truncated).toBeUndefined();
		const firstUrl = new URL(vi.mocked(fetch).mock.calls[0]?.[0] as string);
		expect(firstUrl.searchParams.get('limit')).toBe('250');
		expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
	});
});
