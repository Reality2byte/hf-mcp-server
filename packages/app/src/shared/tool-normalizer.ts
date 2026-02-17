import { HUB_REPO_DETAILS_TOOL_ID, MODEL_DETAIL_TOOL_ID, DATASET_DETAIL_TOOL_ID } from '@llmindset/hf-mcp';
import { mapLegacySearchToolId } from './repo-search-migration.js';

/**
 * Normalizes built-in tool lists coming from UI/API clients.
 * - Deduplicates entries while preserving original order where possible.
 * - Replaces legacy detail tools with the newer hub aggregate tool.
 */
export function normalizeBuiltInTools(ids: readonly string[]): string[] {
	const seen = new Set<string>();
	const normalized: string[] = [];
	let addHubInspect = false;

	for (const rawId of ids) {
		const normalizedToolId = mapLegacySearchToolId(rawId);

		if (normalizedToolId === MODEL_DETAIL_TOOL_ID || normalizedToolId === DATASET_DETAIL_TOOL_ID) {
			addHubInspect = true;
			continue;
		}

		if (!seen.has(normalizedToolId)) {
			seen.add(normalizedToolId);
			normalized.push(normalizedToolId);
		}
	}

	if (addHubInspect && !seen.has(HUB_REPO_DETAILS_TOOL_ID)) {
		seen.add(HUB_REPO_DETAILS_TOOL_ID);
		normalized.push(HUB_REPO_DETAILS_TOOL_ID);
	}

	return normalized;
}
