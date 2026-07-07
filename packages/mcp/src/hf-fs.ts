import { z } from 'zod';
import {
	HUB_URL,
	downloadFile,
	datasetInfo,
	HubApiError,
	listDatasets,
	listFiles,
	listModels,
	listSpaces,
	modelInfo,
	pathsInfo,
	spaceInfo,
	whoAmI,
} from '@huggingface/hub';
import type {
	DatasetEntry,
	ListFileEntry,
	ModelEntry,
	PathInfo,
	RepoDesignation,
	RepoType,
	SpaceEntry,
} from '@huggingface/hub';
import picomatch from 'picomatch';
import { safeFetch } from './network/safe-fetch.js';
import { createHuggingFaceHubPolicy } from './network/url-policy.js';
import { assertTextFilePath, decodeTextFileContent } from './text-file-policy.js';
import { escapeMarkdown, fitsWithinCharBudget, formatBytes, maxCharsForTokenBudget } from './utilities.js';
import { HfNavTool, type HfNavEntry, type HfNavParams, type HfNavResult } from './hf-nav.js';

const HF_FS_OPERATIONS = ['ls', 'cat', 'stat', 'find', 'search'] as const;
const HF_FS_ENTRY_TYPES = ['file', 'dir', 'repo', 'bucket', 'collection', 'link'] as const;
const HF_FS_STAT_TYPES = ['namespace', 'repo', 'dir', 'file', 'collection', 'link', 'missing'] as const;
const HF_URI_TYPES = ['models', 'datasets', 'spaces', 'buckets', 'collections'] as const;
const HF_REPO_TYPES = ['model', 'dataset', 'space', 'bucket'] as const;
const HF_FS_SEARCH_SORTS = [
	'createdAt',
	'downloads',
	'likes',
	'lastModified',
	'likes30d',
	'trendingScore',
	'mainSize',
	'id',
	'trending',
	'upvotes',
] as const;
const SPECIAL_REFS_REVISION_RE = /^refs\/(?:convert\/[\w.-]+|pr\/\d+)/;
const UNSUPPORTED_RAW_SLASH_REVISION_RE = /^refs\/(?:heads|tags)\//;
const DEFAULT_LS_LIMIT = 1000;
const MAX_LS_LIMIT = 10_000;
const DEFAULT_SEARCH_LIMIT = 100;
const MAX_SEARCH_LIMIT = 1000;
const DEFAULT_CAT_MAX_BYTES = 20_000;
const APPROX_CHARS_PER_TOKEN = 4;
const MAX_UTF8_SEQUENCE_BYTES = 4;
export const HF_FS_MAX_OUTPUT_TOKENS = 20_000;
export const HF_FS_MAX_OUTPUT_CHARS = maxCharsForTokenBudget(HF_FS_MAX_OUTPUT_TOKENS, APPROX_CHARS_PER_TOKEN);
const MAX_CAT_BYTES = HF_FS_MAX_OUTPUT_CHARS;

export const HF_FILES_FLAG = 'hf_files' as const;

function hfFsUriDescription(username?: string): string {
	const ownerHint = username ? `Authenticated OWNER is ${username}.` : '';
	return `Hugging Face URI in the form hf://models|datasets|spaces|buckets/OWNER[/NAME[/PATH]] or hf://collections[/OWNER[/SLUG]]. ${ownerHint}`;
}

function createHfFsSchema(username?: string) {
	return z.object({
		op: z.enum(HF_FS_OPERATIONS),
		uri: z.string().min(1).describe(hfFsUriDescription(username)),
		glob: z.string().optional(),
		recursive: z.boolean().optional().default(false),
		entry_type: z.enum(HF_FS_ENTRY_TYPES).optional(),
		name: z.string().optional().describe('find glob matched against entry name/basename.'),
		path: z.string().optional().describe('find glob matched against entry path relative to the requested URI.'),
		query: z.string().optional().describe('Search query for hf://models, hf://datasets, hf://spaces, or hf://collections.'),
		sort: z.enum(HF_FS_SEARCH_SORTS).optional().describe('Search/list sort field.'),
		cursor: z.string().optional().describe('Opaque search continuation cursor.'),
		max_bytes: z
			.number()
			.int()
			.nonnegative()
			.max(MAX_CAT_BYTES)
			.optional()
			.describe(`cat max read length. 0 means the maximum allowed ${MAX_CAT_BYTES.toString()} bytes.`),
		offset: z.number().int().nonnegative().optional().describe('cat read start offset.'),
		limit: z
			.number()
			.int()
			.nonnegative()
			.max(MAX_LS_LIMIT)
			.optional()
			.describe(
				`ls/search max result size. ls default ${DEFAULT_LS_LIMIT.toString()}; search default ${DEFAULT_SEARCH_LIMIT.toString()}. 0 means the maximum allowed.`
			),
	});
}

export const HF_FS_TOOL_CONFIG = {
	name: 'hf_fs',
	title: 'Hugging Face Files',
	description: 'Read, list, find, and search Hugging Face Hub files, repos, buckets, and collections',
	schema: createHfFsSchema(),
	outputSchema: createHfFsOutputSchema(),
	annotations: {
		destructiveHint: false,
		readOnlyHint: true,
		openWorldHint: true,
	},
} as const;

type HfFsToolSchema = ReturnType<typeof createHfFsSchema>;
type HfFsToolConfig = Omit<typeof HF_FS_TOOL_CONFIG, 'description' | 'schema'> & {
	description: string;
	schema: HfFsToolSchema;
};

export type HfFsParams = z.input<typeof HF_FS_TOOL_CONFIG.schema>;
export type HfFsOperation = (typeof HF_FS_OPERATIONS)[number];
export type HfFsEntryType = (typeof HF_FS_ENTRY_TYPES)[number];

function createHfFsOutputSchema() {
	const entrySchema = z.object({
		type: z.enum(HF_FS_ENTRY_TYPES),
		path: z.string(),
		uri: z.string().optional(),
		name: z.string().optional(),
		target_uri: z.string().optional(),
		target_type: z.enum(['repo', 'collection', 'paper', 'bucket']).optional(),
		repo_type: z.enum(HF_REPO_TYPES).optional(),
		size: z.number().optional(),
		total_files: z.number().optional(),
		lfs: z.boolean().optional(),
		private: z.boolean().optional(),
		gated: z.union([z.literal(false), z.enum(['auto', 'manual'])]).optional(),
		likes: z.number().optional(),
		downloads: z.number().optional(),
		task: z.string().optional(),
		sdk: z.string().optional(),
		title: z.string().optional(),
		description: z.string().optional(),
		upvotes: z.number().optional(),
		created_at: z.string().optional(),
		updated_at: z.string().optional(),
		content_type: z.literal('application/json').optional(),
	});

	return z.object({
		uri: z.string(),
		op: z.enum(HF_FS_OPERATIONS),
		strategy: z.string().optional(),
		entries: z.array(entrySchema).optional(),
		path: z.string().optional(),
		content: z.string().optional(),
		content_type: z.literal('application/json').optional(),
		bytes: z.number().optional(),
		exists: z.boolean().optional(),
		type: z.enum(HF_FS_STAT_TYPES).optional(),
		namespace: z.string().optional(),
		size: z.number().optional(),
		lfs: z.boolean().optional(),
		truncated: z.boolean().optional(),
		truncation_reason: z.enum(['entry_limit', 'max_bytes', 'limit']).optional(),
		truncation_message: z.string().optional(),
		next_offset: z.number().optional(),
		next_cursor: z.string().optional(),
	});
}

function normalizedLsLimit(limit: number | undefined): number {
	return limit === undefined ? DEFAULT_LS_LIMIT : limit === 0 ? MAX_LS_LIMIT : limit;
}

function normalizedSearchLimit(limit: number | undefined): number {
	return limit === undefined ? DEFAULT_SEARCH_LIMIT : limit === 0 ? MAX_SEARCH_LIMIT : Math.min(limit, MAX_SEARCH_LIMIT);
}

function normalizedCatMaxBytes(maxBytes: number | undefined): number {
	return maxBytes === undefined ? DEFAULT_CAT_MAX_BYTES : maxBytes === 0 ? MAX_CAT_BYTES : maxBytes;
}

function validateHfFsParams(params: HfFsParams): void {
	if (params.glob !== undefined && params.op !== 'ls') {
		throw new Error('EINVAL: glob applies only to ls');
	}
	if (params.query !== undefined && params.op !== 'search') {
		throw new Error('EINVAL: query applies only to search');
	}
	if (params.cursor !== undefined && params.op !== 'search') {
		throw new Error('EINVAL: cursor applies only to search');
	}
	if (params.recursive === true && params.op !== 'ls') {
		throw new Error('EINVAL: recursive applies only to ls');
	}
	if ((params.name !== undefined || params.path !== undefined) && params.op !== 'find') {
		throw new Error('EINVAL: name and path apply only to find');
	}
	if (params.op === 'search' && !params.query?.trim()) {
		throw new Error('EINVAL: search requires query');
	}
}

function isNavigationUri(uri: string): boolean {
	return uri.startsWith('hf://collections');
}

function isRootUri(uri: string): boolean {
	return uri === 'hf://' || uri === 'hf:///';
}

function toNavParams(params: HfFsParams): HfNavParams {
	const navEntryType = navCompatibleEntryType(params.entry_type);
	const navParams: HfNavParams = {
		op: params.op,
		uri: params.uri,
		...(params.glob !== undefined ? { glob: params.glob } : {}),
		...(params.recursive !== undefined ? { recursive: params.recursive } : {}),
		...(params.name !== undefined ? { name: params.name } : {}),
		...(params.path !== undefined ? { path: params.path } : {}),
		...(navEntryType !== undefined ? { type: navEntryType } : {}),
		...(params.query !== undefined ? { query: params.query } : {}),
		...(params.limit !== undefined ? { limit: Math.min(normalizedSearchLimit(params.limit), MAX_SEARCH_LIMIT) } : {}),
		...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
	};
	if (params.sort === 'trending' || params.sort === 'upvotes' || params.sort === 'lastModified') {
		navParams.sort = params.sort;
	}
	return navParams;
}

function navResultToFsResult(result: HfNavResult): HfFsResult {
	switch (result.op) {
		case 'ls':
		case 'find':
		case 'search':
			return {
				uri: result.uri,
				op: result.op,
				entries: result.entries.map(navEntryToFsEntry),
				...(result.truncated ? { truncated: true, truncation_reason: 'limit' as const } : {}),
				...(result.next_cursor ? { next_cursor: result.next_cursor } : {}),
				...(result.strategy ? { strategy: result.strategy } : {}),
			};
		case 'stat':
			return {
				uri: result.uri,
				op: 'stat',
				exists: result.exists,
				type: result.type,
				path: result.path,
				...(result.content_type ? { content_type: result.content_type } : {}),
				...(result.strategy ? { strategy: result.strategy } : {}),
			};
		case 'cat': {
			const bytes = new TextEncoder().encode(result.content).byteLength;
			return {
				uri: result.uri,
				op: 'cat',
				path: hfUriPath(result.uri),
				content: result.content,
				content_type: result.content_type,
				bytes,
				truncated: false,
				...(result.strategy ? { strategy: result.strategy } : {}),
			};
		}
	}
}

function navEntryToFsEntry(entry: HfNavEntry): HfFsEntry {
	return compactEntry({
		type: entry.type,
		path: entry.path,
		uri: entry.uri,
		name: entry.name,
		target_uri: entry.target_uri,
		target_type: entry.target_type,
		repo_type: entry.repo_type,
		private: entry.private,
		title: entry.title,
		description: entry.description,
		upvotes: entry.upvotes,
		created_at: entry.created_at,
		updated_at: entry.updated_at,
		content_type: entry.content_type,
	});
}

function compactEntry(entry: HfFsEntry): HfFsEntry {
	return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)) as HfFsEntry;
}

function hfUriPath(uri: string): string {
	return uri.startsWith('hf://') ? uri.slice('hf://'.length).replace(/^\/+/, '') : uri;
}

function navCompatibleEntryType(entryType: HfFsParams['entry_type']): HfNavParams['type'] | undefined {
	if (entryType === 'file' || entryType === 'dir' || entryType === 'collection' || entryType === 'link') {
		return entryType;
	}
	return undefined;
}

function encodeSearchCursor(offset: number): string {
	return `offset:${offset.toString()}`;
}

function decodeSearchCursor(cursor: string | undefined): number {
	if (!cursor) {
		return 0;
	}
	const match = /^offset:(\d+)$/.exec(cursor);
	if (!match) {
		throw new Error('EINVAL: invalid cursor');
	}
	return Number.parseInt(match[1] ?? '0', 10);
}

function repoSearchSort(sort: (typeof HF_FS_SEARCH_SORTS)[number] | undefined): RepoSearchSort | undefined {
	if (sort === 'trending' || sort === 'upvotes') {
		return 'trendingScore';
	}
	return sort;
}

export interface HfFsEntry {
	type: HfFsEntryType;
	path: string;
	uri?: string;
	name?: string;
	target_uri?: string;
	target_type?: 'repo' | 'collection' | 'paper' | 'bucket';
	repo_type?: RepoType;
	size?: number;
	total_files?: number;
	lfs?: boolean;
	private?: boolean;
	gated?: false | 'auto' | 'manual';
	likes?: number;
	downloads?: number;
	task?: string;
	sdk?: string;
	title?: string;
	description?: string;
	upvotes?: number;
	created_at?: string;
	updated_at?: string;
	content_type?: 'application/json';
}

export interface HfFsLsResult {
	uri: string;
	op: 'ls' | 'find' | 'search';
	entries: HfFsEntry[];
	truncated?: boolean;
	truncation_reason?: 'entry_limit' | 'limit';
	truncation_message?: string;
	next_offset?: number;
	next_cursor?: string;
	strategy?: string;
}

export interface HfFsCatResult {
	uri: string;
	op: 'cat';
	path: string;
	content: string;
	content_type?: 'application/json';
	bytes: number;
	truncated: boolean;
	truncation_reason?: 'max_bytes';
	truncation_message?: string;
	next_offset?: number;
	strategy?: string;
}

export interface HfFsStatResult {
	uri: string;
	op: 'stat';
	exists: boolean;
	type: 'namespace' | 'repo' | 'dir' | 'file' | 'collection' | 'link' | 'missing';
	path: string;
	content_type?: 'application/json';
	namespace?: string;
	size?: number;
	lfs?: boolean;
	strategy?: string;
}

export type HfFsResult = HfFsLsResult | HfFsCatResult | HfFsStatResult;

export type ParsedHfUri = ParsedNamespaceHfUri | ParsedRepoHfUri;

export interface ParsedNamespaceHfUri {
	kind: 'namespace';
	repoType: RepoType;
	namespace?: string;
	path: '';
}

type RepoSearchSort = Exclude<(typeof HF_FS_SEARCH_SORTS)[number], 'trending' | 'upvotes'>;

export interface ParsedRepoHfUri {
	kind: 'repo';
	repo: RepoDesignation;
	repoType: RepoType;
	repoId: string;
	namespace: string;
	revision?: string;
	path: string;
}

interface ApiBucketEntry {
	_id: string;
	id: string;
	author: string;
	private: boolean;
	createdAt: string;
	updatedAt: string;
	size: number;
	totalFiles: number;
	repoType: 'bucket';
	cdnRegions?: string[];
	resourceGroup?: { id: string; name: string };
}

export class HfFsTool {
	private readonly accessToken?: string;
	private readonly hubUrl?: string;

	constructor(hfToken?: string, hubUrl?: string) {
		this.accessToken = hfToken;
		this.hubUrl = hubUrl;
	}

	static createToolConfig(username?: string): HfFsToolConfig {
		const ownerHint = username
			? ` URIs without an owner default to ${username}.`
			: ' Anonymous requests must include an owner.';
		return {
			...HF_FS_TOOL_CONFIG,
			description: `List, read, find, or search Hugging Face repos, buckets, files, and collections.${ownerHint}`,
			schema: createHfFsSchema(username),
		};
	}

	async run(params: HfFsParams): Promise<HfFsResult> {
		validateHfFsParams(params);
		if (isNavigationUri(params.uri) || params.op === 'find') {
			return await this.runNavigation(params);
		}
		switch (params.op) {
			case 'ls':
				return await this.ls(params);
			case 'cat':
				return await this.cat(params);
			case 'stat':
				return await this.stat(params);
			case 'search':
				return await this.search(params);
		}
		throw new Error('ENOTSUP: unsupported hf_fs operation');
	}

	private async runNavigation(params: HfFsParams): Promise<HfFsResult> {
		const tool = new HfNavTool(this.accessToken, this.hubUrl);
		return navResultToFsResult(await tool.run(toNavParams(params)));
	}

	private async ls(params: HfFsParams): Promise<HfFsLsResult> {
		if (isRootUri(params.uri)) {
			return {
				uri: 'hf://',
				op: 'ls',
				entries: ['collections', 'models', 'datasets', 'spaces', 'buckets'].map((name) => ({
					type: 'dir',
					path: name,
					name,
					uri: `hf://${name}`,
				})),
			};
		}
		const parsed = parseHfFsUri(params.uri);
		if (parsed.kind === 'namespace') {
			return await this.lsNamespace(params, parsed);
		}

		const offset = params.offset ?? 0;
		const limit = normalizedLsLimit(params.limit);
		const matcher = params.glob ? picomatch(params.glob, { dot: true }) : undefined;
		const entries: HfFsEntry[] = [];
		let matchedCount = 0;
		let truncated = false;

		for await (const file of listFiles({
			repo: parsed.repo,
			path: parsed.path || undefined,
			recursive: params.recursive ?? false,
			expand: true,
			...(parsed.revision ? { revision: parsed.revision } : {}),
			...(this.hubUrl ? { hubUrl: this.hubUrl } : {}),
			...(this.accessToken ? { accessToken: this.accessToken } : {}),
		})) {
			const entry = toHfFsEntry(file);
			if (!entry) {
				continue;
			}
			if (params.entry_type && entry.type !== params.entry_type) {
				continue;
			}
			if (matcher && !matcher(relativeEntryPath(parsed.path, entry.path))) {
				continue;
			}

			if (matchedCount < offset) {
				matchedCount += 1;
				continue;
			}

			if (entries.length >= limit) {
				truncated = true;
				break;
			}

			entries.push(entry);
			matchedCount += 1;
		}

		return buildLsResult(params.uri, entries, offset, truncated, truncated ? 'entry_limit' : undefined);
	}

	private async search(params: HfFsParams): Promise<HfFsLsResult> {
		if (isRootUri(params.uri)) {
			throw new Error('ENOTSUP: search requires a scoped discovery root such as hf://models, hf://datasets, or hf://collections.');
		}
		const parsed = parseHfFsUri(params.uri);
		if (parsed.kind === 'repo') {
			throw new Error('ENOTSUP: search is supported on discovery roots or owner namespaces, not repository file paths.');
		}
		if (parsed.repoType === 'bucket') {
			throw new Error('ENOTSUP: bucket search is not supported.');
		}

		const query = params.query?.trim();
		if (!query) {
			throw new Error('EINVAL: search requires query');
		}

		const offset = decodeSearchCursor(params.cursor);
		const limit = normalizedSearchLimit(params.limit);
		const fetchLimit = offset + limit + 1;
		const entries: HfFsEntry[] = [];
		let index = 0;
		for await (const entry of this.searchRepoEntries(parsed.repoType, {
			query,
			owner: parsed.namespace,
			sort: repoSearchSort(params.sort),
			limit: fetchLimit,
		})) {
			if (index++ < offset) {
				continue;
			}
			if (entries.length >= limit) {
				return {
					uri: params.uri,
					op: 'search',
					entries,
					truncated: true,
					truncation_reason: 'limit',
					next_cursor: encodeSearchCursor(offset + entries.length),
				};
			}
			entries.push(entry);
		}

		return {
			uri: params.uri,
			op: 'search',
			entries,
		};
	}

	private async cat(params: HfFsParams): Promise<HfFsCatResult> {
		const parsed = parseHfFsUri(params.uri);
		if (parsed.kind === 'namespace') {
			throw new Error('cat requires a URI that points to a file path, not a namespace.');
		}
		if (!parsed.path) {
			throw new Error('cat requires a URI that points to a file path.');
		}

		const stat = await this.stat(params);
		if (!stat.exists) {
			throw new Error(`File does not exist: ${parsed.path}`);
		}
		if (stat.type !== 'file') {
			throw new Error(`cat requires a file path, got ${stat.type}: ${parsed.path}`);
		}
		assertTextFilePath(parsed.path);

		const blob = await downloadFile({
			repo: parsed.repo,
			path: parsed.path,
			...(parsed.revision ? { revision: parsed.revision } : {}),
			...(this.hubUrl ? { hubUrl: this.hubUrl } : {}),
			...(this.accessToken ? { accessToken: this.accessToken } : {}),
		});
		if (!blob) {
			throw new Error(`File does not exist: ${parsed.path}`);
		}

		const offset = params.offset ?? 0;
		const maxBytes = normalizedCatMaxBytes(params.max_bytes);
		const end = Math.min(offset + maxBytes, blob.size);
		const range = await decodeTextFileByteRange(parsed.path, blob, offset, end);
		const truncated = range.end < blob.size;

		return {
			uri: params.uri,
			op: 'cat',
			path: parsed.path,
			content: range.content,
			bytes: range.bytes,
			truncated,
			...(truncated ? { truncation_reason: 'max_bytes', next_offset: range.end } : {}),
		};
	}

	private async stat(params: HfFsParams): Promise<HfFsStatResult> {
		if (isRootUri(params.uri)) {
			return {
				uri: params.uri,
				op: 'stat',
				exists: true,
				type: 'dir',
				path: '',
			};
		}
		const parsed = parseHfFsUri(params.uri);
		if (parsed.kind === 'namespace') {
			const namespace = await this.resolveNamespace(parsed);
			return {
				uri: params.uri,
				op: 'stat',
				exists: true,
				type: 'namespace',
				path: '',
				namespace,
			};
		}

		if (!parsed.path) {
			return await this.statRepoRoot(params.uri, parsed);
		}

		const [path] = await pathsInfo({
			repo: parsed.repo,
			paths: [parsed.path],
			expand: true,
			...(parsed.revision ? { revision: parsed.revision } : {}),
			...(this.hubUrl ? { hubUrl: this.hubUrl } : {}),
			...(this.accessToken ? { accessToken: this.accessToken } : {}),
		});
		if (!path) {
			return {
				uri: params.uri,
				op: 'stat',
				exists: false,
				type: 'missing',
				path: parsed.path,
			};
		}

		const type = toStatType(path);
		return {
			uri: params.uri,
			op: 'stat',
			exists: true,
			type,
			path: path.path,
			...(type === 'file' ? optionalSize(path.size) : {}),
			...(type === 'file' ? optionalLfs(path) : {}),
		};
	}

	private async statRepoRoot(uri: string, parsed: ParsedRepoHfUri): Promise<HfFsStatResult> {
		const exists = await this.repoRootExists(parsed);
		return {
			uri,
			op: 'stat',
			exists,
			type: exists ? 'repo' : 'missing',
			path: '',
		};
	}

	private async repoRootExists(parsed: ParsedRepoHfUri): Promise<boolean> {
		try {
			switch (parsed.repoType) {
				case 'model':
					await modelInfo({
						name: parsed.repoId,
						...(parsed.revision ? { revision: parsed.revision } : {}),
						...(this.hubUrl ? { hubUrl: this.hubUrl } : {}),
						...(this.accessToken ? { accessToken: this.accessToken } : {}),
						fetch: this.safeHubFetch,
					});
					return true;
				case 'dataset':
					await datasetInfo({
						name: parsed.repoId,
						...(parsed.revision ? { revision: parsed.revision } : {}),
						...(this.hubUrl ? { hubUrl: this.hubUrl } : {}),
						...(this.accessToken ? { accessToken: this.accessToken } : {}),
						fetch: this.safeHubFetch,
					});
					return true;
				case 'space':
					await spaceInfo({
						name: parsed.repoId,
						...(parsed.revision ? { revision: parsed.revision } : {}),
						...(this.hubUrl ? { hubUrl: this.hubUrl } : {}),
						...(this.accessToken ? { accessToken: this.accessToken } : {}),
						fetch: this.safeHubFetch,
					});
					return true;
				case 'bucket':
					return await this.bucketExists(parsed.repoId);
			}
		} catch (error) {
			if (isNotFoundError(error)) {
				return false;
			}
			throw error;
		}
	}

	private readonly safeHubFetch: typeof fetch = async (url, requestInit) => {
		const safeUrl = typeof url === 'string' || url instanceof URL ? url : url.url;
		const { response } = await safeFetch(safeUrl, {
			urlPolicy: createHuggingFaceHubPolicy(),
			requestInit,
		});
		return response;
	};

	private async bucketExists(repoId: string): Promise<boolean> {
		const [namespace] = repoId.split('/');
		if (!namespace) {
			return false;
		}

		for await (const bucket of this.listBuckets(namespace)) {
			if (bucket.id === repoId) {
				return true;
			}
		}
		return false;
	}

	private async lsNamespace(params: HfFsParams, parsed: ParsedNamespaceHfUri): Promise<HfFsLsResult> {
		const namespace = await this.resolveNamespace(parsed);
		const offset = params.offset ?? 0;
		const limit = normalizedLsLimit(params.limit);
		const matcher = params.glob ? picomatch(params.glob, { dot: true }) : undefined;
		const entries: HfFsEntry[] = [];
		let matchedCount = 0;
		let truncated = false;

		const namespaceFetchLimit = matcher ? undefined : limit + offset + 1;
		for await (const entry of this.listNamespaceEntries(parsed.repoType, namespace, namespaceFetchLimit)) {
			if (params.entry_type && entry.type !== params.entry_type) {
				continue;
			}
			if (matcher && !matcher(relativeNamespaceEntryPath(namespace, entry.path))) {
				continue;
			}

			if (matchedCount < offset) {
				matchedCount += 1;
				continue;
			}

			if (entries.length >= limit) {
				truncated = true;
				break;
			}

			entries.push(entry);
			matchedCount += 1;
		}

		return buildLsResult(params.uri, entries, offset, truncated, truncated ? 'entry_limit' : undefined);
	}

	private async resolveNamespace(parsed: ParsedNamespaceHfUri): Promise<string> {
		if (parsed.namespace) {
			return parsed.namespace;
		}
		if (!this.accessToken) {
			throw new Error(
				`Listing ${uriTypeForRepoType(parsed.repoType)} without an owner requires authentication. Use hf://${uriTypeForRepoType(
					parsed.repoType
				)}/<owner> or provide an HF token.`
			);
		}

		const identity = await whoAmI({
			accessToken: this.accessToken,
			...(this.hubUrl ? { hubUrl: this.hubUrl } : {}),
		});
		return identity.name;
	}

	private async *listNamespaceEntries(
		repoType: RepoType,
		namespace: string,
		limit?: number
	): AsyncGenerator<HfFsEntry> {
		switch (repoType) {
			case 'model':
				for await (const model of listModels({
					search: { owner: namespace },
					sort: 'lastModified',
					...(limit === undefined ? {} : { limit }),
					...(this.hubUrl ? { hubUrl: this.hubUrl } : {}),
					...(this.accessToken ? { accessToken: this.accessToken } : {}),
				})) {
					yield modelToEntry(model);
				}
				return;
			case 'dataset':
				for await (const dataset of listDatasets({
					search: { owner: namespace },
					sort: 'lastModified',
					...(limit === undefined ? {} : { limit }),
					...(this.hubUrl ? { hubUrl: this.hubUrl } : {}),
					...(this.accessToken ? { accessToken: this.accessToken } : {}),
				})) {
					yield datasetToEntry(dataset);
				}
				return;
			case 'space':
				for await (const space of listSpaces({
					search: { owner: namespace },
					sort: 'lastModified',
					...(this.hubUrl ? { hubUrl: this.hubUrl } : {}),
					...(this.accessToken ? { accessToken: this.accessToken } : {}),
				})) {
					yield spaceToEntry(space);
				}
				return;
			case 'bucket':
				for await (const bucket of this.listBuckets(namespace)) {
					yield bucketToEntry(bucket);
				}
				return;
		}
	}

	private async *searchRepoEntries(
		repoType: Exclude<RepoType, 'bucket'>,
		options: { query: string; owner?: string; sort?: RepoSearchSort; limit: number }
	): AsyncGenerator<HfFsEntry> {
		switch (repoType) {
			case 'model':
				for await (const model of listModels({
					search: { query: options.query, ...(options.owner ? { owner: options.owner } : {}) },
					...(options.sort ? { sort: options.sort } : {}),
					limit: options.limit,
					...(this.hubUrl ? { hubUrl: this.hubUrl } : {}),
					...(this.accessToken ? { accessToken: this.accessToken } : {}),
				})) {
					yield modelToEntry(model);
				}
				return;
			case 'dataset':
				for await (const dataset of listDatasets({
					search: { query: options.query, ...(options.owner ? { owner: options.owner } : {}) },
					...(options.sort ? { sort: options.sort } : {}),
					limit: options.limit,
					...(this.hubUrl ? { hubUrl: this.hubUrl } : {}),
					...(this.accessToken ? { accessToken: this.accessToken } : {}),
				})) {
					yield datasetToEntry(dataset);
				}
				return;
			case 'space':
				for await (const space of listSpaces({
					search: { query: options.query, ...(options.owner ? { owner: options.owner } : {}) },
					...(options.sort ? { sort: options.sort } : {}),
					...(this.hubUrl ? { hubUrl: this.hubUrl } : {}),
					...(this.accessToken ? { accessToken: this.accessToken } : {}),
				})) {
					yield spaceToEntry(space);
				}
				return;
		}
	}

	private async *listBuckets(namespace: string): AsyncGenerator<ApiBucketEntry> {
		const url = `${this.hubUrl ?? HUB_URL}/api/buckets/${encodeURIComponent(namespace)}`;
		const { response } = await safeFetch(url, {
			urlPolicy: createHuggingFaceHubPolicy(),
			requestInit: {
				headers: {
					accept: 'application/json',
					...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
				},
			},
		});
		if (!response.ok) {
			throw new Error(`Bucket listing failed with status ${response.status.toString()}: ${await response.text()}`);
		}

		const buckets = (await response.json()) as ApiBucketEntry[];
		for (const bucket of buckets) {
			yield bucket;
		}
	}
}

export function formatHfFsResult(result: HfFsResult): string {
	return JSON.stringify(result, null, 2);
}

export function formatHfFsMarkdown(result: HfFsResult, maxChars = HF_FS_MAX_OUTPUT_CHARS): string {
	return trimMarkdownToBudget(renderHfFsMarkdown(result), maxChars);
}

function renderHfFsMarkdown(result: HfFsResult): string {
	switch (result.op) {
		case 'ls':
		case 'find':
		case 'search':
			return renderLsMarkdown(result);
		case 'cat':
			return renderCatMarkdown(result);
		case 'stat':
			return renderStatMarkdown(result);
	}
}

function renderLsMarkdown(result: HfFsLsResult): string {
	const lines = [
		`# hf_fs ${result.op}`,
		``,
		`URI: ${inlineCode(result.uri)}`,
		``,
		`| Type | Path | Size | Details |`,
		`|---|---|---:|---|`,
	];
	for (const entry of result.entries) {
		lines.push(
			`| ${escapeMarkdown(entry.type)} | ${escapeMarkdown(entry.path)} | ${entry.size === undefined ? '' : escapeMarkdown(formatBytes(entry.size))} | ${escapeMarkdown(entryDetails(entry))} |`
		);
	}
	if (result.truncated) {
		lines.push(
			'',
			result.truncation_message ?? `Result truncated. Resume with offset ${String(result.next_offset ?? 0)}.`
		);
	}
	return lines.join('\n');
}

function renderCatMarkdown(result: HfFsCatResult): string {
	const lines = [`# hf_fs cat`, ``, `Path: ${inlineCode(result.path)}`, `Bytes: ${result.bytes.toString()}`, ``];
	lines.push(result.content);
	if (result.truncated) {
		lines.push(
			'',
			result.truncation_message ?? `Content truncated. Resume with offset ${String(result.next_offset ?? 0)}.`
		);
	}
	return lines.join('\n');
}

function renderStatMarkdown(result: HfFsStatResult): string {
	const lines = [
		`# hf_fs stat`,
		``,
		`- URI: ${inlineCode(result.uri)}`,
		`- Exists: ${result.exists ? 'yes' : 'no'}`,
		`- Type: ${inlineCode(result.type)}`,
		`- Path: ${inlineCode(result.path)}`,
	];
	if (result.namespace) {
		lines.push(`- Namespace: ${inlineCode(result.namespace)}`);
	}
	if (result.size !== undefined) {
		lines.push(`- Size: ${formatBytes(result.size)}`);
	}
	if (result.lfs !== undefined) {
		lines.push(`- LFS: ${result.lfs ? 'yes' : 'no'}`);
	}
	return lines.join('\n');
}

function entryDetails(entry: HfFsEntry): string {
	const details = [
		entry.repo_type ? `repo=${entry.repo_type}` : undefined,
		entry.target_type ? `target=${entry.target_type}` : undefined,
		entry.private === undefined ? undefined : entry.private ? 'private' : 'public',
		entry.gated ? `gated=${entry.gated}` : undefined,
		entry.lfs === undefined ? undefined : entry.lfs ? 'lfs' : 'non-lfs',
		entry.total_files === undefined ? undefined : `files=${entry.total_files.toString()}`,
		entry.likes === undefined ? undefined : `likes=${entry.likes.toString()}`,
		entry.downloads === undefined ? undefined : `downloads=${entry.downloads.toString()}`,
		entry.task ? `task=${entry.task}` : undefined,
		entry.sdk ? `sdk=${entry.sdk}` : undefined,
		entry.title ? `title=${entry.title}` : undefined,
		entry.upvotes === undefined ? undefined : `upvotes=${entry.upvotes.toString()}`,
		entry.updated_at ? `updated=${entry.updated_at}` : undefined,
		entry.created_at ? `created=${entry.created_at}` : undefined,
	].filter((detail): detail is string => detail !== undefined);
	return details.join(', ');
}

function trimMarkdownToBudget(markdown: string, maxChars: number): string {
	if (fitsWithinCharBudget(markdown, maxChars)) {
		return markdown;
	}

	const suffix = `\n\n_Markdown view truncated to fit the hf_fs output budget of approximately ${HF_FS_MAX_OUTPUT_TOKENS.toString()} tokens. structuredContent contains the full returned result._`;
	if (suffix.length >= maxChars) {
		return suffix.slice(0, maxChars);
	}
	return `${markdown.slice(0, maxChars - suffix.length).trimEnd()}${suffix}`;
}

function inlineCode(value: string): string {
	return `\`${value.replace(/`/g, '\\`')}\``;
}

interface DecodedTextByteRange {
	content: string;
	bytes: number;
	start: number;
	end: number;
}

async function decodeTextFileByteRange(
	filePath: string,
	blob: Blob,
	offset: number,
	end: number
): Promise<DecodedTextByteRange> {
	if (offset >= blob.size || end <= offset) {
		return { content: '', bytes: 0, start: offset, end: offset };
	}

	const windowStart = Math.max(0, offset - (MAX_UTF8_SEQUENCE_BYTES - 1));
	const windowEnd = Math.min(blob.size, end + (MAX_UTF8_SEQUENCE_BYTES - 1));
	const windowBytes = new Uint8Array(await blob.slice(windowStart, windowEnd).arrayBuffer());
	const byteAt = (absoluteOffset: number): number | undefined => windowBytes[absoluteOffset - windowStart];

	let rangeStart = offset;
	while (rangeStart > windowStart && isUtf8ContinuationByte(byteAt(rangeStart))) {
		rangeStart -= 1;
	}

	let rangeEnd = end;
	while (rangeEnd < blob.size && rangeEnd < windowEnd && isUtf8ContinuationByte(byteAt(rangeEnd))) {
		rangeEnd += 1;
	}

	const bytes = windowBytes.slice(rangeStart - windowStart, rangeEnd - windowStart);
	const content = decodeTextFileContent(filePath, bytes);
	return { content, bytes: bytes.byteLength, start: rangeStart, end: rangeEnd };
}

function isUtf8ContinuationByte(byte: number | undefined): boolean {
	return byte !== undefined && byte >= 0x80 && byte <= 0xbf;
}

function isNotFoundError(error: unknown): boolean {
	return error instanceof HubApiError && error.statusCode === 404;
}

function buildLsResult(
	uri: string,
	entries: HfFsEntry[],
	offset: number,
	truncated: boolean,
	truncationReason?: HfFsLsResult['truncation_reason']
): HfFsLsResult {
	return {
		uri,
		op: 'ls',
		entries,
		...(truncated
			? {
					truncated,
					truncation_reason: truncationReason,
					truncation_message: `Result truncated after reaching the entry limit. Resume with offset ${(offset + entries.length).toString()}.`,
					next_offset: offset + entries.length,
				}
			: {}),
	};
}

export function parseHfFsUri(uri: string): ParsedHfUri {
	if (!uri.startsWith('hf://')) {
		throw new Error('URI must start with hf://.');
	}

	const location = uri.slice('hf://'.length).replace(/^\/+|\/+$/g, '');
	if (!location) {
		throw new Error('Missing repository or bucket type in URI.');
	}
	if (location.includes('//')) {
		throw new Error('URI path must not contain empty segments.');
	}

	const slashIndex = location.indexOf('/');
	const prefix = slashIndex === -1 ? location : location.slice(0, slashIndex);
	const body = slashIndex === -1 ? '' : location.slice(slashIndex + 1);
	const repoType = parseUriType(prefix);

	if (repoType === 'collection') {
		throw new Error('Collection URIs are handled by the navigation layer.');
	}

	if (repoType === 'bucket') {
		return parseBucketUri(body, repoType);
	}
	return parseRepoUri(body, repoType);
}

function parseUriType(prefix: string): RepoType | 'collection' {
	if (!isHfUriType(prefix)) {
		throw new Error(`Invalid URI type '${prefix}'. Must be one of ${HF_URI_TYPES.join(', ')}.`);
	}

	switch (prefix) {
		case 'models':
			return 'model';
		case 'datasets':
			return 'dataset';
		case 'spaces':
			return 'space';
		case 'buckets':
			return 'bucket';
		case 'collections':
			return 'collection';
	}
}

function parseBucketUri(body: string, repoType: RepoType): ParsedHfUri {
	if (!body) {
		return { kind: 'namespace', repoType, path: '' };
	}
	const parts = body.split('/', 3);
	if (parts.length === 1) {
		const namespace = parts[0];
		if (!namespace) {
			throw new Error(`Bucket owner must not be empty.`);
		}
		return { kind: 'namespace', repoType, namespace: decodeSegment(namespace), path: '' };
	}
	if (!parts[0] || !parts[1]) {
		throw new Error(`Bucket id must be 'owner/name', got '${body}'.`);
	}
	const repoId = `${decodeSegment(parts[0])}/${decodeSegment(parts[1])}`;
	if (repoId.includes('@')) {
		throw new Error("Bucket URIs do not support a revision marker ('@').");
	}
	const path = parts.length > 2 ? decodePath(body.split('/').slice(2).join('/')) : '';
	return {
		kind: 'repo',
		repo: { type: repoType, name: repoId },
		repoType,
		repoId,
		namespace: decodeSegment(parts[0]),
		path,
	};
}

function parseRepoUri(body: string, repoType: RepoType): ParsedHfUri {
	if (!body) {
		return { kind: 'namespace', repoType, path: '' };
	}
	const atIndex = body.indexOf('@');
	let repoId: string;
	let revision: string | undefined;
	let path: string;

	const namespaceOnly = !body.includes('/') && atIndex === -1;
	if (namespaceOnly) {
		return { kind: 'namespace', repoType, namespace: decodeSegment(body), path: '' };
	}

	if (atIndex !== -1 && body.slice(0, atIndex).split('/').length === 2) {
		repoId = decodeRepoId(body.slice(0, atIndex));
		const revAndPath = body.slice(atIndex + 1);
		const parsedRevision = splitRevisionAndPath(revAndPath);
		revision = decodeURIComponent(parsedRevision.revision);
		path = decodePath(parsedRevision.path);
		if (!revision) {
			throw new Error("Revision after '@' must not be empty.");
		}
	} else {
		const parts = body.split('/', 3);
		if (parts.length < 2 || !parts[0] || !parts[1]) {
			throw new Error(`Repository id must be 'owner/name', got '${body}'.`);
		}
		repoId = `${decodeSegment(parts[0])}/${decodeSegment(parts[1])}`;
		path = parts.length > 2 ? decodePath(body.split('/').slice(2).join('/')) : '';
	}

	return {
		kind: 'repo',
		repo: { type: repoType, name: repoId },
		repoType,
		repoId,
		namespace: repoId.split('/')[0] ?? '',
		...(revision ? { revision } : {}),
		path,
	};
}

function splitRevisionAndPath(revAndPath: string): { revision: string; path: string } {
	const specialRefMatch = SPECIAL_REFS_REVISION_RE.exec(revAndPath);
	if (specialRefMatch) {
		const revision = specialRefMatch[0];
		return {
			revision,
			path: revAndPath.slice(revision.length).replace(/^\//, ''),
		};
	}

	if (UNSUPPORTED_RAW_SLASH_REVISION_RE.test(revAndPath)) {
		throw new Error(
			"Revision names containing '/' must be percent-encoded in hf:// URIs unless they are refs/pr/N or refs/convert/NAME. For example, use refs%2Fheads%2Ffeature instead of refs/heads/feature."
		);
	}

	const slashIndex = revAndPath.indexOf('/');
	if (slashIndex === -1) {
		return { revision: revAndPath, path: '' };
	}
	return {
		revision: revAndPath.slice(0, slashIndex),
		path: revAndPath.slice(slashIndex + 1),
	};
}

function decodeRepoId(value: string): string {
	const parts = value.split('/');
	if (parts.length !== 2 || !parts[0] || !parts[1]) {
		throw new Error(`Repository id must be 'owner/name', got '${value}'.`);
	}
	return `${decodeSegment(parts[0])}/${decodeSegment(parts[1])}`;
}

function decodePath(path: string): string {
	if (!path) {
		return '';
	}
	return path.split('/').map(decodeSegment).join('/');
}

function decodeSegment(segment: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		throw new Error(`Invalid percent-encoding in URI segment '${segment}'.`);
	}
}

function isHfUriType(value: string): value is (typeof HF_URI_TYPES)[number] {
	return (HF_URI_TYPES as readonly string[]).includes(value);
}

function toHfFsEntry(file: ListFileEntry): HfFsEntry | null {
	const type = toEntryType(file.type);
	if (!type) {
		return null;
	}
	return {
		type,
		path: file.path,
		...(type === 'file' ? optionalSize(file.size) : {}),
		...(type === 'file' ? optionalLfs(file) : {}),
		...(type === 'file' ? optionalUpdatedAt(file.uploadedAt ?? file.lastCommit?.date) : {}),
	};
}

function toEntryType(type: ListFileEntry['type']): HfFsEntryType | null {
	if (type === 'file') {
		return 'file';
	}
	if (type === 'directory') {
		return 'dir';
	}
	return null;
}

function toStatType(path: PathInfo): HfFsStatResult['type'] {
	if (path.type === 'file') {
		return 'file';
	}
	if (path.type === 'directory') {
		return 'dir';
	}
	return 'missing';
}

function optionalSize(size: number | undefined): { size?: number } {
	return typeof size === 'number' && Number.isFinite(size) ? { size } : {};
}

function optionalLfs(file: Pick<ListFileEntry, 'lfs' | 'xetHash'>): { lfs?: boolean } {
	return file.lfs || file.xetHash ? { lfs: Boolean(file.lfs) } : {};
}

function optionalUpdatedAt(value: string | undefined): { updated_at?: string } {
	return value ? { updated_at: value } : {};
}

function modelToEntry(model: ModelEntry): HfFsEntry {
	return {
		type: 'repo',
		path: model.name,
		uri: `hf://models/${model.name}`,
		repo_type: 'model',
		private: model.private,
		gated: model.gated,
		likes: model.likes,
		downloads: model.downloads,
		...(model.task ? { task: model.task } : {}),
		updated_at: model.updatedAt.toISOString(),
	};
}

function datasetToEntry(dataset: DatasetEntry): HfFsEntry {
	return {
		type: 'repo',
		path: dataset.name,
		uri: `hf://datasets/${dataset.name}`,
		repo_type: 'dataset',
		private: dataset.private,
		gated: dataset.gated,
		likes: dataset.likes,
		downloads: dataset.downloads,
		updated_at: dataset.updatedAt.toISOString(),
	};
}

function spaceToEntry(space: SpaceEntry): HfFsEntry {
	return {
		type: 'repo',
		path: space.name,
		uri: `hf://spaces/${space.name}`,
		repo_type: 'space',
		private: space.private,
		likes: space.likes,
		...(space.sdk ? { sdk: space.sdk } : {}),
		updated_at: space.updatedAt.toISOString(),
	};
}

function bucketToEntry(bucket: ApiBucketEntry): HfFsEntry {
	return {
		type: 'bucket',
		path: bucket.id,
		uri: `hf://buckets/${bucket.id}`,
		repo_type: 'bucket',
		private: bucket.private,
		size: bucket.size,
		total_files: bucket.totalFiles,
		created_at: bucket.createdAt,
		updated_at: bucket.updatedAt,
	};
}

function relativeEntryPath(basePath: string, entryPath: string): string {
	if (!basePath) {
		return entryPath;
	}
	if (entryPath === basePath) {
		return '';
	}
	const prefix = `${basePath}/`;
	return entryPath.startsWith(prefix) ? entryPath.slice(prefix.length) : entryPath;
}

function relativeNamespaceEntryPath(namespace: string, entryPath: string): string {
	const prefix = `${namespace}/`;
	return entryPath.startsWith(prefix) ? entryPath.slice(prefix.length) : entryPath;
}

function uriTypeForRepoType(repoType: RepoType): (typeof HF_URI_TYPES)[number] {
	switch (repoType) {
		case 'model':
			return 'models';
		case 'dataset':
			return 'datasets';
		case 'space':
			return 'spaces';
		case 'bucket':
			return 'buckets';
	}
}
