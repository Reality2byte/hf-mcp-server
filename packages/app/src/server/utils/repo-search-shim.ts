import { REPO_SEARCH_TOOL_ID } from '@llmindset/hf-mcp';
import {
	isLegacyDatasetSearchTool,
	isLegacyModelSearchTool,
	isLegacyRepoSearchTool,
} from '../../shared/repo-search-migration.js';

interface RewriteResult {
	rewrittenBody: unknown;
	legacyToolName?: string;
	rewrittenToolName?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function toStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value.filter((item): item is string => typeof item === 'string');
}

function uniq(values: string[]): string[] {
	return [...new Set(values)];
}

function rewriteModelSearchArguments(argumentsInput: unknown): Record<string, unknown> {
	if (!isRecord(argumentsInput)) {
		return { repo_types: ['model'] };
	}

	const nextArgs: Record<string, unknown> = { ...argumentsInput, repo_types: ['model'] };
	const existingFilters = toStringArray(nextArgs.filters);
	const task = typeof nextArgs.task === 'string' ? nextArgs.task : undefined;
	const library = typeof nextArgs.library === 'string' ? nextArgs.library : undefined;
	const mergedFilters = uniq([
		...existingFilters,
		...(task ? [task] : []),
		...(library ? [library] : []),
	]);

	delete nextArgs.task;
	delete nextArgs.library;

	if (mergedFilters.length > 0) {
		nextArgs.filters = mergedFilters;
	} else {
		delete nextArgs.filters;
	}

	return nextArgs;
}

function rewriteDatasetSearchArguments(argumentsInput: unknown): Record<string, unknown> {
	if (!isRecord(argumentsInput)) {
		return { repo_types: ['dataset'] };
	}

	const nextArgs: Record<string, unknown> = { ...argumentsInput, repo_types: ['dataset'] };
	const existingFilters = toStringArray(nextArgs.filters);
	const tags = toStringArray(nextArgs.tags);
	const mergedFilters = uniq([...existingFilters, ...tags]);

	delete nextArgs.tags;

	if (mergedFilters.length > 0) {
		nextArgs.filters = mergedFilters;
	} else {
		delete nextArgs.filters;
	}

	return nextArgs;
}

/**
 * Rewrites legacy tools/call payloads for model_search / dataset_search
 * into canonical hub_repo_search requests.
 */
export function rewriteLegacySearchToolCallRequest(requestBody: unknown): RewriteResult {
	if (!isRecord(requestBody)) {
		return { rewrittenBody: requestBody };
	}

	if (requestBody.method !== 'tools/call') {
		return { rewrittenBody: requestBody };
	}

	const params = requestBody.params;
	if (!isRecord(params)) {
		return { rewrittenBody: requestBody };
	}

	const toolName = params.name;
	if (typeof toolName !== 'string') {
		return { rewrittenBody: requestBody };
	}

	if (isLegacyModelSearchTool(toolName)) {
		const rewrittenBody: Record<string, unknown> = {
			...requestBody,
			params: {
				...params,
				name: REPO_SEARCH_TOOL_ID,
				arguments: rewriteModelSearchArguments(params.arguments),
			},
		};

		return {
			rewrittenBody,
			legacyToolName: toolName,
			rewrittenToolName: REPO_SEARCH_TOOL_ID,
		};
	}

	if (isLegacyDatasetSearchTool(toolName)) {
		const rewrittenBody: Record<string, unknown> = {
			...requestBody,
			params: {
				...params,
				name: REPO_SEARCH_TOOL_ID,
				arguments: rewriteDatasetSearchArguments(params.arguments),
			},
		};

		return {
			rewrittenBody,
			legacyToolName: toolName,
			rewrittenToolName: REPO_SEARCH_TOOL_ID,
		};
	}

	if (isLegacyRepoSearchTool(toolName)) {
		const rewrittenBody: Record<string, unknown> = {
			...requestBody,
			params: {
				...params,
				name: REPO_SEARCH_TOOL_ID,
			},
		};

		return {
			rewrittenBody,
			legacyToolName: toolName,
			rewrittenToolName: REPO_SEARCH_TOOL_ID,
		};
	}

	return { rewrittenBody: requestBody };
}
