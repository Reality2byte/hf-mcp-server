import { describe, expect, it } from 'vitest';
import { CREATE_REPO_TOOL_CONFIG } from './create-repo.js';
import { HF_FS_TOOL_CONFIG } from './hf-fs.js';
import { HF_FS_WRITE_TOOL_CONFIG } from './hf-fs-write.js';
import { HUB_REPO_DETAILS_TOOL_CONFIG } from './hub-inspect.js';
import { HF_JOBS_TOOL_CONFIG } from './jobs/jobs-tool.js';
import { REPO_SEARCH_TOOL_CONFIG } from './repo-search.js';
import { HF_SANDBOX_EXEC_TOOL_CONFIG, HF_SANDBOX_FS_TOOL_CONFIG, HF_SANDBOX_TOOL_CONFIG } from './sandbox-tool.js';
import { DYNAMIC_SPACE_TOOL_CONFIG, getDynamicSpaceToolConfig } from './space/dynamic-space-tool.js';

describe('MCP tool annotations', () => {
	it.each([
		['hub_repo_search', REPO_SEARCH_TOOL_CONFIG],
		['hub_repo_details', HUB_REPO_DETAILS_TOOL_CONFIG],
		['hf_fs', HF_FS_TOOL_CONFIG],
	])('%s explicitly advertises all safety hints for submission compatibility', (_name, config) => {
		expect(config.annotations).toEqual({
			title: config.title,
			destructiveHint: false,
			idempotentHint: false,
			readOnlyHint: true,
			openWorldHint: true,
		});
	});

	it('classifies repository creation as additive but non-idempotent', () => {
		expect(CREATE_REPO_TOOL_CONFIG.annotations).toEqual({
			title: CREATE_REPO_TOOL_CONFIG.title,
			destructiveHint: false,
			idempotentHint: false,
			readOnlyHint: false,
			openWorldHint: true,
		});
	});

	it.each([
		['hf_fs_write', HF_FS_WRITE_TOOL_CONFIG],
		['hf_jobs', HF_JOBS_TOOL_CONFIG],
		['hf_sandbox', HF_SANDBOX_TOOL_CONFIG],
		['hf_sandbox_exec', HF_SANDBOX_EXEC_TOOL_CONFIG],
		['hf_sandbox_fs', HF_SANDBOX_FS_TOOL_CONFIG],
		['dynamic_space', DYNAMIC_SPACE_TOOL_CONFIG],
	])('%s is conservatively classified as mutable, destructive, and non-idempotent', (_name, config) => {
		expect(config.annotations).toEqual({
			title: config.title,
			destructiveHint: true,
			idempotentHint: false,
			readOnlyHint: false,
			openWorldHint: true,
		});
	});

	it('keeps the runtime dynamic Space configuration aligned with the static configuration', () => {
		const config = getDynamicSpaceToolConfig();

		expect(config.title).toBe(DYNAMIC_SPACE_TOOL_CONFIG.title);
		expect(config.annotations).toEqual(DYNAMIC_SPACE_TOOL_CONFIG.annotations);
	});
});
