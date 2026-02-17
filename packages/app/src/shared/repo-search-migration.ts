import { DATASET_SEARCH_TOOL_ID, MODEL_SEARCH_TOOL_ID, REPO_SEARCH_TOOL_ID } from '@llmindset/hf-mcp';

/**
 * Additional legacy identifiers seen in external settings payloads.
 * These are treated as aliases for the current canonical tool IDs.
 */
const LEGACY_MODEL_SEARCH_ALIASES = new Set([MODEL_SEARCH_TOOL_ID, 'model-search', 'hf_model_search']);
const LEGACY_DATASET_SEARCH_ALIASES = new Set([DATASET_SEARCH_TOOL_ID, 'dataset-search', 'hf_dataset_search']);
const LEGACY_REPO_SEARCH_ALIASES = new Set([REPO_SEARCH_TOOL_ID, 'repo_search', 'repo-search', 'hf_repo_search']);

/**
 * Hard migration helper for search tools.
 *
 * If legacy model/dataset search IDs are encountered in settings, map them
 * to the canonical hub_repo_search ID so only hub_repo_search is exposed downstream.
 */
export function mapLegacySearchToolId(toolId: string): string {
	if (
		LEGACY_MODEL_SEARCH_ALIASES.has(toolId) ||
		LEGACY_DATASET_SEARCH_ALIASES.has(toolId) ||
		LEGACY_REPO_SEARCH_ALIASES.has(toolId)
	) {
		return REPO_SEARCH_TOOL_ID;
	}

	return toolId;
}

export function isLegacyModelSearchTool(toolName: string): boolean {
	return LEGACY_MODEL_SEARCH_ALIASES.has(toolName);
}

export function isLegacyDatasetSearchTool(toolName: string): boolean {
	return LEGACY_DATASET_SEARCH_ALIASES.has(toolName);
}

export function isLegacyRepoSearchTool(toolName: string): boolean {
	return LEGACY_REPO_SEARCH_ALIASES.has(toolName) && toolName !== REPO_SEARCH_TOOL_ID;
}
