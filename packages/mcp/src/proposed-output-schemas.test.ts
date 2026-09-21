import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HUB_REPO_SEARCH_PROPOSED_OUTPUT_SCHEMA } from './repo-search-output-schema.js';
import { HUB_REPO_DETAILS_PROPOSED_OUTPUT_SCHEMA } from './hub-repo-details-output-schema.js';
import { HF_JOBS_PROPOSED_OUTPUT_SCHEMA } from './jobs/hf-jobs-output-schema.js';
import { DYNAMIC_SPACE_PROPOSED_OUTPUT_SCHEMA } from './space/dynamic-space-output-schema.js';

describe('proposed output schemas', () => {
	it.each([
		['hub_repo_search', HUB_REPO_SEARCH_PROPOSED_OUTPUT_SCHEMA],
		['hub_repo_details', HUB_REPO_DETAILS_PROPOSED_OUTPUT_SCHEMA],
		['hf_jobs', HF_JOBS_PROPOSED_OUTPUT_SCHEMA],
		['dynamic_space', DYNAMIC_SPACE_PROPOSED_OUTPUT_SCHEMA],
	])('%s has an object-root JSON Schema suitable for later MCP attachment', (_name, schema) => {
		expect(z.toJSONSchema(schema)).toMatchObject({ type: 'object' });
	});

	it('accepts a typed repository-search result', () => {
		expect(
			HUB_REPO_SEARCH_PROPOSED_OUTPUT_SCHEMA.parse({
				criteria: {
					query: 'text generation',
					repo_types: ['model'],
					limit_per_type: 20,
				},
				groups: [
					{
						repo_type: 'model',
						total_results: 1,
						results: [
							{
								repo_type: 'model',
								id: 'org/model',
								url: 'https://huggingface.co/org/model',
								pipeline_tag: 'text-generation',
							},
						],
					},
				],
				total_results: 1,
				results_shared: 1,
				truncated: false,
			})
		).toMatchObject({ total_results: 1, results_shared: 1 });
	});

	it('accepts per-repository errors without losing successful-result counts', () => {
		expect(
			HUB_REPO_DETAILS_PROPOSED_OUTPUT_SCHEMA.parse({
				requested_operations: ['overview'],
				repositories: [{ status: 'error', repo_id: 'missing/repo', error: 'Not found' }],
				total_results: 1,
				results_shared: 0,
			})
		).toMatchObject({ total_results: 1, results_shared: 0 });
	});

	it('accepts a sanitized jobs result', () => {
		expect(
			HF_JOBS_PROPOSED_OUTPUT_SCHEMA.parse({
				operation: 'ps',
				outcome: {
					kind: 'jobs',
					jobs: [],
					total_jobs: 0,
				},
				total_results: 0,
				results_shared: 0,
			})
		).toMatchObject({ operation: 'ps', outcome: { kind: 'jobs' } });
	});

	it('rejects undeclared value-bearing fields from proposed job records', () => {
		expect(() =>
			HF_JOBS_PROPOSED_OUTPUT_SCHEMA.parse({
				operation: 'inspect',
				outcome: {
					kind: 'job',
					job: {
						id: 'job-id',
						created_at: '2026-08-04T00:00:00.000Z',
						environment_variable_names: ['PUBLIC_SETTING'],
						secret_names: ['HF_TOKEN'],
						environment: { PUBLIC_SETTING: 'value' },
						secrets: { HF_TOKEN: 'secret' },
						flavor: 'cpu-basic',
						status: { stage: 'RUNNING' },
						owner: { id: 'user-id', name: 'alice', type: 'user' },
					},
				},
				total_results: 1,
				results_shared: 1,
			})
		).toThrow();
	});

	it('accepts an enveloped arbitrary dynamic-space invocation result', () => {
		expect(
			DYNAMIC_SPACE_PROPOSED_OUTPUT_SCHEMA.parse({
				operation: 'invoke',
				outcome: {
					kind: 'invoke_result',
					space_name: 'org/space',
					warnings: [],
					is_error: false,
					upstream_content: [{ type: 'text', text: 'done' }],
					upstream_structured_content: { result_url: 'https://example.com/result' },
				},
				total_results: 1,
				results_shared: 1,
			})
		).toMatchObject({ operation: 'invoke', outcome: { kind: 'invoke_result' } });
	});
});
