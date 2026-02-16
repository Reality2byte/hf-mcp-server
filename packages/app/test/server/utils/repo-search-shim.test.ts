import { describe, it, expect } from 'vitest';
import { REPO_SEARCH_TOOL_ID } from '@llmindset/hf-mcp';
import { rewriteLegacySearchToolCallRequest } from '../../../src/server/utils/repo-search-shim.js';

describe('rewriteLegacySearchToolCallRequest', () => {
	it('rewrites model_search calls to hub_repo_search with repo_types=model', () => {
		const requestBody = {
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: {
				name: 'model_search',
				arguments: {
					query: 'qwen',
					author: 'zai-org',
					task: 'text-generation',
					library: 'transformers',
					filters: ['featured'],
				},
			},
		};

		const result = rewriteLegacySearchToolCallRequest(requestBody);
		const rewritten = result.rewrittenBody as {
			params: { name: string; arguments: Record<string, unknown> };
		};

		expect(result.legacyToolName).toBe('model_search');
		expect(rewritten.params.name).toBe(REPO_SEARCH_TOOL_ID);
		expect(rewritten.params.arguments).toMatchObject({
			query: 'qwen',
			author: 'zai-org',
			repo_types: ['model'],
			filters: ['featured', 'text-generation', 'transformers'],
		});
		expect(rewritten.params.arguments).not.toHaveProperty('task');
		expect(rewritten.params.arguments).not.toHaveProperty('library');
	});

	it('rewrites dataset_search calls to hub_repo_search with repo_types=dataset', () => {
		const requestBody = {
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/call',
			params: {
				name: 'dataset_search',
				arguments: {
					query: 'vision',
					tags: ['language:en', 'task_categories:image-classification'],
				},
			},
		};

		const result = rewriteLegacySearchToolCallRequest(requestBody);
		const rewritten = result.rewrittenBody as {
			params: { name: string; arguments: Record<string, unknown> };
		};

		expect(result.legacyToolName).toBe('dataset_search');
		expect(rewritten.params.name).toBe(REPO_SEARCH_TOOL_ID);
		expect(rewritten.params.arguments).toMatchObject({
			query: 'vision',
			repo_types: ['dataset'],
			filters: ['language:en', 'task_categories:image-classification'],
		});
		expect(rewritten.params.arguments).not.toHaveProperty('tags');
	});

	it('rewrites hf_* legacy call names to hub_repo_search', () => {
		const requestBody = {
			jsonrpc: '2.0',
			id: 4,
			method: 'tools/call',
			params: {
				name: 'hf_model_search',
				arguments: { query: 'qwen' },
			},
		};

		const result = rewriteLegacySearchToolCallRequest(requestBody);
		const rewritten = result.rewrittenBody as {
			params: { name: string; arguments: Record<string, unknown> };
		};

		expect(result.legacyToolName).toBe('hf_model_search');
		expect(rewritten.params.name).toBe(REPO_SEARCH_TOOL_ID);
		expect(rewritten.params.arguments).toMatchObject({ query: 'qwen', repo_types: ['model'] });
	});

	it('rewrites legacy repo_search alias calls to hub_repo_search', () => {
		const requestBody = {
			jsonrpc: '2.0',
			id: 3,
			method: 'tools/call',
			params: {
				name: 'repo_search',
				arguments: { query: 'llm' },
			},
		};

		const result = rewriteLegacySearchToolCallRequest(requestBody);
		const rewritten = result.rewrittenBody as {
			params: { name: string; arguments: Record<string, unknown> };
		};

		expect(result.legacyToolName).toBe('repo_search');
		expect(rewritten.params.name).toBe(REPO_SEARCH_TOOL_ID);
		expect(rewritten.params.arguments).toMatchObject({ query: 'llm' });
	});

	it('leaves canonical hub_repo_search calls unchanged', () => {
		const requestBody = {
			jsonrpc: '2.0',
			id: 5,
			method: 'tools/call',
			params: {
				name: REPO_SEARCH_TOOL_ID,
				arguments: { query: 'llm' },
			},
		};

		const result = rewriteLegacySearchToolCallRequest(requestBody);

		expect(result.legacyToolName).toBeUndefined();
		expect(result.rewrittenBody).toBe(requestBody);
	});
});
