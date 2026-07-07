import { describe, it, expect } from 'vitest';
import {
	DATASET_DETAIL_TOOL_ID,
	DATASET_SEARCH_TOOL_ID,
	HF_FILES_FLAG,
	HF_FS_TOOL_ID,
	HF_NAV_TOOL_ID,
	MODEL_DETAIL_TOOL_ID,
	MODEL_SEARCH_TOOL_ID,
	REPO_SEARCH_TOOL_ID,
	HUB_REPO_DETAILS_TOOL_ID,
} from '@llmindset/hf-mcp';
import { normalizeBuiltInTools } from '../../src/shared/tool-normalizer.js';

describe('normalizeBuiltInTools', () => {
	it('maps legacy model/dataset search tools to hub_repo_search', () => {
		const result = normalizeBuiltInTools([MODEL_SEARCH_TOOL_ID, REPO_SEARCH_TOOL_ID, DATASET_SEARCH_TOOL_ID]);

		expect(result).toEqual([REPO_SEARCH_TOOL_ID]);
	});

	it('maps hyphenated legacy search aliases to hub_repo_search', () => {
		const result = normalizeBuiltInTools(['model-search', 'dataset-search']);

		expect(result).toEqual([REPO_SEARCH_TOOL_ID]);
	});

	it('maps hf_* legacy search aliases to hub_repo_search', () => {
		const result = normalizeBuiltInTools(['hf_model_search', 'hf_dataset_search', 'hf_repo_search']);

		expect(result).toEqual([REPO_SEARCH_TOOL_ID]);
	});

	it('maps legacy repo_search alias to hub_repo_search', () => {
		const result = normalizeBuiltInTools(['repo_search']);

		expect(result).toEqual([REPO_SEARCH_TOOL_ID]);
	});

	it('still collapses legacy detail tools into hub repo details', () => {
		const result = normalizeBuiltInTools([MODEL_DETAIL_TOOL_ID, 'custom_flag', DATASET_DETAIL_TOOL_ID]);

		expect(result).toEqual(['custom_flag', HUB_REPO_DETAILS_TOOL_ID]);
	});

	it('maps external hf_files flag to hf_fs tool id', () => {
		const result = normalizeBuiltInTools([HF_FILES_FLAG]);

		expect(result).toEqual([HF_FILES_FLAG, HF_FS_TOOL_ID, HF_NAV_TOOL_ID]);
	});

	it('maps hub query API flags to hf_nav', () => {
		expect(normalizeBuiltInTools(['hf_hub_query'])).toEqual(['hf_hub_query', HF_NAV_TOOL_ID]);
		expect(normalizeBuiltInTools(['hub_query'])).toEqual(['hub_query', HF_NAV_TOOL_ID]);
	});
});
