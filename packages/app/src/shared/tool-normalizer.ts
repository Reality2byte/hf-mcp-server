import {
	HF_FILES_FLAG,
	HF_FS_TOOL_ID,
	HF_NAV_TOOL_ID,
	HUB_REPO_DETAILS_TOOL_ID,
	MODEL_DETAIL_TOOL_ID,
	DATASET_DETAIL_TOOL_ID,
} from '@llmindset/hf-mcp';
import { mapLegacySearchToolId } from './repo-search-migration.js';

const HUB_QUERY_FLAGS = new Set(['hf_hub_query', 'hub_query']);

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
		if (rawId === HF_FILES_FLAG) {
			for (const id of [HF_FILES_FLAG, HF_FS_TOOL_ID]) {
				if (!seen.has(id)) {
					seen.add(id);
					normalized.push(id);
				}
			}
			continue;
		}

		if (HUB_QUERY_FLAGS.has(rawId)) {
			for (const id of [rawId, HF_FS_TOOL_ID]) {
				if (!seen.has(id)) {
					seen.add(id);
					normalized.push(id);
				}
			}
			continue;
		}

		const normalizedToolId = mapLegacySearchToolId(rawId);
		const canonicalToolId = normalizedToolId === HF_NAV_TOOL_ID ? HF_FS_TOOL_ID : normalizedToolId;

		if (canonicalToolId === MODEL_DETAIL_TOOL_ID || canonicalToolId === DATASET_DETAIL_TOOL_ID) {
			addHubInspect = true;
			continue;
		}

		if (!seen.has(canonicalToolId)) {
			seen.add(canonicalToolId);
			normalized.push(canonicalToolId);
		}
	}

	if (addHubInspect && !seen.has(HUB_REPO_DETAILS_TOOL_ID)) {
		seen.add(HUB_REPO_DETAILS_TOOL_ID);
		normalized.push(HUB_REPO_DETAILS_TOOL_ID);
	}

	return normalized;
}
