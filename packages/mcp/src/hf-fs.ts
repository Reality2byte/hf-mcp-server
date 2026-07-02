import { z } from 'zod';
import {
	HUB_URL,
	downloadFile,
	listDatasets,
	listFiles,
	listModels,
	listSpaces,
	pathsInfo,
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
import { fitsWithinCharBudget, maxCharsForTokenBudget } from './utilities.js';

const HF_FS_OPERATIONS = ['ls', 'cat', 'stat'] as const;
const HF_FS_ENTRY_TYPES = ['file', 'dir', 'repo', 'bucket'] as const;
const HF_URI_TYPES = ['models', 'datasets', 'spaces', 'buckets'] as const;
const DEFAULT_LS_LIMIT = 1000;
const MAX_LS_LIMIT = 10_000;
const DEFAULT_CAT_MAX_BYTES = 20_000;
const APPROX_CHARS_PER_TOKEN = 4;
export const HF_FS_MAX_OUTPUT_TOKENS = 20_000;
export const HF_FS_MAX_OUTPUT_CHARS = maxCharsForTokenBudget(HF_FS_MAX_OUTPUT_TOKENS, APPROX_CHARS_PER_TOKEN);
const MAX_CAT_BYTES = HF_FS_MAX_OUTPUT_CHARS;

export const HF_FILES_FLAG = 'hf_files' as const;

function hfFsUriDescription(username?: string): string {
	const ownerDefault = username ? ` Defaults owner: '${username}').` : '';
	return `Hugging Face URI in the form hf://models|datasets|spaces|buckets[/OWNER[/NAME[/PATH]]]. Owner-only ls lists repos or buckets.${ownerDefault}`;
}

function createHfFsSchema(username?: string) {
	return z.object({
		op: z.enum(HF_FS_OPERATIONS),
		uri: z.string().min(1).describe(hfFsUriDescription(username)),
		glob: z.string().optional(),
		recursive: z.boolean().optional().default(false),
		entry_type: z.enum(HF_FS_ENTRY_TYPES).optional(),
		max_bytes: z.number().int().nonnegative().max(MAX_CAT_BYTES).optional().describe(`cat max read length.`),
		offset: z.number().int().nonnegative().optional().describe('cat read start offset.'),
		limit: z
			.number()
			.int()
			.nonnegative()
			.max(MAX_LS_LIMIT)
			.optional()
			.describe(`ls max list size. Default ${DEFAULT_LS_LIMIT.toString()}.`),
	});
}

export const HF_FS_TOOL_CONFIG = {
	name: 'hf_fs',
	title: 'Hugging Face Files',
	description: 'Read and list files and repos on Hugging Face',
	schema: createHfFsSchema(),
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

export interface HfFsEntry {
	type: HfFsEntryType;
	path: string;
	uri?: string;
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
	created_at?: string;
	updated_at?: string;
}

export interface HfFsLsResult {
	uri: string;
	op: 'ls';
	entries: HfFsEntry[];
	truncated?: boolean;
	truncation_reason?: 'entry_limit' | 'output_tokens';
	truncation_message?: string;
	next_offset?: number;
}

export interface HfFsCatResult {
	uri: string;
	op: 'cat';
	path: string;
	content: string;
	bytes: number;
	truncated: boolean;
	truncation_reason?: 'max_bytes' | 'output_tokens';
	truncation_message?: string;
	next_offset?: number;
}

export interface HfFsStatResult {
	uri: string;
	op: 'stat';
	exists: boolean;
	type: 'namespace' | 'repo' | 'dir' | 'file' | 'missing';
	path: string;
	namespace?: string;
	size?: number;
	lfs?: boolean;
}

export type HfFsResult = HfFsLsResult | HfFsCatResult | HfFsStatResult;

export type ParsedHfUri = ParsedNamespaceHfUri | ParsedRepoHfUri;

export interface ParsedNamespaceHfUri {
	kind: 'namespace';
	repoType: RepoType;
	namespace?: string;
	path: '';
}

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
			? `URIs without an owner, such as hf://models, default to ${username}.`
			: 'Anonymous requests must include an owner, such as hf://models/openai.';
		return {
			...HF_FS_TOOL_CONFIG,
			description: `Read-only: list or read files from a Hugging Face repo or bucket. ${ownerHint}`,
			schema: createHfFsSchema(username),
		};
	}

	async run(params: HfFsParams): Promise<HfFsResult> {
		switch (params.op) {
			case 'ls':
				return await this.ls(params);
			case 'cat':
				return await this.cat(params);
			case 'stat':
				return await this.stat(params);
		}
	}

	private async ls(params: HfFsParams): Promise<HfFsLsResult> {
		const parsed = parseHfFsUri(params.uri);
		if (parsed.kind === 'namespace') {
			return await this.lsNamespace(params, parsed);
		}

		const offset = params.offset ?? 0;
		const limit = params.limit ?? DEFAULT_LS_LIMIT;
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

			const nextEntries = [...entries, entry];
			if (!fitsOutputBudget(buildLsResult(params.uri, nextEntries, offset, true, 'output_tokens'))) {
				truncated = true;
				break;
			}

			entries.push(entry);
			matchedCount += 1;
		}

		return buildLsResult(
			params.uri,
			entries,
			offset,
			truncated,
			truncated && entries.length >= limit ? 'entry_limit' : 'output_tokens'
		);
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
		const maxBytes = Math.min(params.max_bytes ?? DEFAULT_CAT_MAX_BYTES, MAX_CAT_BYTES);
		const end = Math.min(offset + maxBytes, blob.size);
		const slice = blob.slice(offset, end);
		const bytes = new Uint8Array(await slice.arrayBuffer());
		const truncated = end < blob.size;

		return trimCatResultToBudget(
			{
				uri: params.uri,
				op: 'cat',
				path: parsed.path,
				content: new TextDecoder('utf-8').decode(bytes),
				bytes: bytes.byteLength,
				truncated,
				...(truncated ? { truncation_reason: 'max_bytes', next_offset: end } : {}),
			},
			offset
		);
	}

	private async stat(params: HfFsParams): Promise<HfFsStatResult> {
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
			return {
				uri: params.uri,
				op: 'stat',
				exists: true,
				type: 'repo',
				path: '',
			};
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

	private async lsNamespace(params: HfFsParams, parsed: ParsedNamespaceHfUri): Promise<HfFsLsResult> {
		const namespace = await this.resolveNamespace(parsed);
		const offset = params.offset ?? 0;
		const limit = params.limit ?? DEFAULT_LS_LIMIT;
		const matcher = params.glob ? picomatch(params.glob, { dot: true }) : undefined;
		const entries: HfFsEntry[] = [];
		let matchedCount = 0;
		let truncated = false;

		for await (const entry of this.listNamespaceEntries(parsed.repoType, namespace, limit + offset + 1)) {
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

			const nextEntries = [...entries, entry];
			if (!fitsOutputBudget(buildLsResult(params.uri, nextEntries, offset, true, 'output_tokens'))) {
				truncated = true;
				break;
			}

			entries.push(entry);
			matchedCount += 1;
		}

		return buildLsResult(
			params.uri,
			entries,
			offset,
			truncated,
			truncated && entries.length >= limit ? 'entry_limit' : 'output_tokens'
		);
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

	private async *listNamespaceEntries(repoType: RepoType, namespace: string, limit: number): AsyncGenerator<HfFsEntry> {
		switch (repoType) {
			case 'model':
				for await (const model of listModels({
					search: { owner: namespace },
					sort: 'lastModified',
					limit,
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
					limit,
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

	private async *listBuckets(namespace: string): AsyncGenerator<ApiBucketEntry> {
		const url = `${this.hubUrl ?? HUB_URL}/api/buckets/${encodeURIComponent(namespace)}`;
		const response = await fetch(url, {
			headers: {
				accept: 'application/json',
				...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
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

function buildLsResult(
	uri: string,
	entries: HfFsEntry[],
	offset: number,
	truncated: boolean,
	truncationReason: HfFsLsResult['truncation_reason']
): HfFsLsResult {
	return {
		uri,
		op: 'ls',
		entries,
		...(truncated
			? {
					truncated,
					truncation_reason: truncationReason,
					truncation_message:
						truncationReason === 'entry_limit'
							? `Result truncated after reaching the entry limit. Resume with offset ${(
									offset + entries.length
								).toString()}.`
							: `Result truncated to stay under the hf_fs output budget of approximately ${HF_FS_MAX_OUTPUT_TOKENS.toString()} tokens. Resume with offset ${(
									offset + entries.length
								).toString()}.`,
					next_offset: offset + entries.length,
				}
			: {}),
	};
}

function fitsOutputBudget(result: HfFsResult): boolean {
	return fitsWithinCharBudget(formatHfFsResult(result), HF_FS_MAX_OUTPUT_CHARS);
}

function trimCatResultToBudget(result: HfFsCatResult, offset: number): HfFsCatResult {
	if (fitsOutputBudget(result)) {
		return result;
	}

	let content = result.content;
	while (content.length > 0) {
		const overage = formatHfFsResult({ ...result, content }).length - HF_FS_MAX_OUTPUT_CHARS;
		if (overage <= 0) {
			const bytes = new TextEncoder().encode(content).byteLength;
			const nextOffset = offset + bytes;
			return {
				...result,
				content,
				bytes,
				truncated: true,
				truncation_reason: 'output_tokens',
				truncation_message: `Content truncated to stay under the hf_fs output budget of approximately ${HF_FS_MAX_OUTPUT_TOKENS.toString()} tokens. Resume with offset ${nextOffset.toString()}.`,
				next_offset: nextOffset,
			};
		}
		content = content.slice(0, Math.max(0, content.length - overage - 256));
	}

	return {
		...result,
		content: '',
		bytes: 0,
		truncated: true,
		truncation_reason: 'output_tokens',
		truncation_message: `Content omitted to stay under the hf_fs output budget of approximately ${HF_FS_MAX_OUTPUT_TOKENS.toString()} tokens.`,
		next_offset: offset,
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

	if (repoType === 'bucket') {
		return parseBucketUri(body, repoType);
	}
	return parseRepoUri(body, repoType);
}

function parseUriType(prefix: string): RepoType {
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
	const specialRefMatch = /^refs\/(?:pr\/\d+|convert\/[^/]+)(?:\/|$)/.exec(revAndPath);
	if (specialRefMatch) {
		const revision = specialRefMatch[0].replace(/\/$/, '');
		return {
			revision,
			path: revAndPath.slice(revision.length).replace(/^\//, ''),
		};
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
