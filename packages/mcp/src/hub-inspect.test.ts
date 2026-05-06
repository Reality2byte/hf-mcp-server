import { describe, expect, it } from 'vitest';
import { HUB_REPO_DETAILS_TOOL_CONFIG } from './hub-inspect.js';

describe('HUB_REPO_DETAILS_TOOL_CONFIG', () => {
	it('defaults to overview and accepts dataset viewer operations', () => {
		const parsed = HUB_REPO_DETAILS_TOOL_CONFIG.schema.parse({
			repo_ids: ['rajpurkar/squad'],
			repo_type: 'dataset',
			operations: ['dataset_structure', 'dataset_preview'],
			config: 'plain_text',
			split: 'train',
			offset: 0,
			limit: 5,
		});

		expect(parsed.include_readme).toBe(false);
		expect(parsed.operations).toEqual(['dataset_structure', 'dataset_preview']);
	});

	it('does not expose a redundant readme operation', () => {
		expect(() =>
			HUB_REPO_DETAILS_TOOL_CONFIG.schema.parse({
				repo_ids: ['rajpurkar/squad'],
				operations: ['readme'],
			})
		).toThrow();
	});
});
