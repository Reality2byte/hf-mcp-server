import { Buffer } from 'node:buffer';
import { deleteFile, uploadFile } from '@huggingface/hub';
import type { CommitOutput } from '@huggingface/hub';
import { z } from 'zod';
import { type ParsedRepoHfUri, parseHfFsUri } from './hf-fs.js';
import {
	HF_FS_WRITE_DESCRIPTION,
	HF_FS_WRITE_OPERATIONS,
	HF_FS_WRITE_SCHEMA,
	type HfFsWriteOperation,
	type HfFsWriteParams,
	type HfFsWriteRequest,
	parseHfFsWriteRequest,
} from './hf-fs-write-contract.js';
import { escapeMarkdown, formatBytes, NO_TOKEN_INSTRUCTIONS } from './utilities.js';

export const HF_FS_WRITE_TOOL_ID = 'hf_fs_write' as const;

function createHfFsWriteSchema() {
	return HF_FS_WRITE_SCHEMA;
}

function createHfFsWriteOutputSchema() {
	return z.object({
		uri: z.string(),
		op: z.enum(HF_FS_WRITE_OPERATIONS),
		repo: z.string(),
		repo_type: z.enum(['model', 'dataset', 'space', 'bucket']),
		path: z.string(),
		bytes: z.number().optional(),
		branch: z.string().optional(),
		message: z.string(),
		commit: z
			.object({
				oid: z.string(),
				url: z.string(),
			})
			.optional(),
		pull_request_url: z.string().optional(),
	});
}

export const HF_FS_WRITE_TOOL_CONFIG = {
	name: HF_FS_WRITE_TOOL_ID,
	title: 'Hugging Face File Writes',
	description: HF_FS_WRITE_DESCRIPTION,
	schema: createHfFsWriteSchema(),
	outputSchema: createHfFsWriteOutputSchema(),
	annotations: {
		destructiveHint: true,
		readOnlyHint: false,
		openWorldHint: true,
	},
} as const;

type HfFsWriteToolSchema = ReturnType<typeof createHfFsWriteSchema>;
type HfFsWriteToolConfig = Omit<typeof HF_FS_WRITE_TOOL_CONFIG, 'description' | 'schema'> & {
	description: string;
	schema: HfFsWriteToolSchema;
};

export type { HfFsWriteOperation, HfFsWriteParams, HfFsWriteRequest } from './hf-fs-write-contract.js';

export interface HfFsWriteResult {
	uri: string;
	op: HfFsWriteOperation;
	repo: string;
	repo_type: ParsedRepoHfUri['repoType'];
	path: string;
	bytes?: number;
	branch?: string;
	message: string;
	commit?: {
		oid: string;
		url: string;
	};
	pull_request_url?: string;
}

export class HfFsWriteTool {
	private readonly accessToken?: string;
	private readonly hubUrl?: string;

	constructor(hfToken?: string, hubUrl?: string) {
		this.accessToken = hfToken;
		this.hubUrl = hubUrl;
	}

	static createToolConfig(): HfFsWriteToolConfig {
		return {
			...HF_FS_WRITE_TOOL_CONFIG,
			description: HF_FS_WRITE_DESCRIPTION,
			schema: createHfFsWriteSchema(),
		};
	}

	async run(request: HfFsWriteRequest | HfFsWriteParams): Promise<HfFsWriteResult> {
		if (!this.accessToken) {
			throw new Error(NO_TOKEN_INSTRUCTIONS);
		}
		const params = 'cmd' in request ? parseHfFsWriteRequest(request) : request;

		switch (params.op) {
			case 'put':
				return await this.put(params);
			case 'rm':
				return await this.rm(params);
		}
	}

	private async put(params: HfFsWriteParams): Promise<HfFsWriteResult> {
		const accessToken = this.requireAccessToken();
		const parsed = parseWriteUri(params);
		const branch = resolveBranch(params, parsed);
		const content = contentFromParams(params);
		const message = params.message ?? `Put ${parsed.path}`;
		validateCommitOptions(params, parsed);
		const output = await uploadFile({
			accessToken,
			repo: parsed.repo,
			file: {
				path: parsed.path,
				content: blobFromBytes(content),
			},
			commitTitle: message,
			...(params.description !== undefined ? { commitDescription: params.description } : {}),
			...(branch ? { branch } : {}),
			...(params.create_pr ? { isPullRequest: true } : {}),
			...(params.parent_commit ? { parentCommit: params.parent_commit } : {}),
			...(this.hubUrl ? { hubUrl: this.hubUrl } : {}),
		});

		return buildWriteResult(params, parsed, message, output, {
			bytes: content.byteLength,
			branch,
		});
	}

	private async rm(params: HfFsWriteParams): Promise<HfFsWriteResult> {
		const accessToken = this.requireAccessToken();
		rejectPutContent(params);
		const parsed = parseWriteUri(params);
		const branch = resolveBranch(params, parsed);
		const message = params.message ?? `Remove ${parsed.path}`;
		validateCommitOptions(params, parsed);
		const output = await deleteFile({
			accessToken,
			repo: parsed.repo,
			path: parsed.path,
			commitTitle: message,
			...(params.description !== undefined ? { commitDescription: params.description } : {}),
			...(branch ? { branch } : {}),
			...(params.create_pr ? { isPullRequest: true } : {}),
			...(params.parent_commit ? { parentCommit: params.parent_commit } : {}),
			...(this.hubUrl ? { hubUrl: this.hubUrl } : {}),
		});

		return buildWriteResult(params, parsed, message, output, { branch });
	}

	private requireAccessToken(): string {
		if (!this.accessToken) {
			throw new Error(NO_TOKEN_INSTRUCTIONS);
		}
		return this.accessToken;
	}
}

export function formatHfFsWriteMarkdown(result: HfFsWriteResult): string {
	const lines = [
		`# hf_fs_write ${result.op}`,
		'',
		`Path: ${inlineCode(result.path)}`,
		`Repo: ${inlineCode(result.repo)}`,
	];
	lines.push(`Type: ${inlineCode(result.repo_type)}`);
	if (result.branch) {
		lines.push(`Branch: ${inlineCode(result.branch)}`);
	}
	if (result.bytes !== undefined) {
		lines.push(`Bytes: ${escapeMarkdown(formatBytes(result.bytes))}`);
	}
	lines.push(`Message: ${inlineCode(result.message)}`);
	if (result.commit) {
		lines.push(`Commit: [${escapeMarkdown(result.commit.oid)}](${escapeMarkdown(result.commit.url)})`);
	}
	if (result.pull_request_url) {
		lines.push(`Pull request: ${escapeMarkdown(result.pull_request_url)}`);
	}
	return lines.join('\n');
}

function parseWriteUri(params: HfFsWriteParams): ParsedRepoHfUri {
	const parsed = parseHfFsUri(params.uri);
	if (parsed.kind === 'namespace') {
		throw new Error(`${params.op} requires a URI that points to a file path, not a namespace.`);
	}
	if (!parsed.path) {
		throw new Error(`${params.op} requires a URI that points to a file path.`);
	}
	return parsed;
}

function resolveBranch(params: HfFsWriteParams, parsed: ParsedRepoHfUri): string | undefined {
	if (parsed.repoType === 'bucket') {
		if (params.branch) {
			throw new Error('branch is not supported for bucket writes.');
		}
		return undefined;
	}

	if (params.branch && parsed.revision && params.branch !== parsed.revision) {
		throw new Error("Specify the target branch either with uri '@revision' or with branch, not both.");
	}
	return params.branch ?? parsed.revision;
}

function contentFromParams(params: HfFsWriteParams): Uint8Array {
	if (params.op !== 'put') {
		throw new Error('content is only valid with put.');
	}
	if (params.content === undefined) {
		throw new Error('put requires content.');
	}
	return params.base64 ? decodeBase64(params.content) : new TextEncoder().encode(params.content);
}

function rejectPutContent(params: HfFsWriteParams): void {
	if (params.content !== undefined || params.base64) {
		throw new Error('content and --base64 are only valid with put.');
	}
}

function validateCommitOptions(params: HfFsWriteParams, parsed: ParsedRepoHfUri): void {
	if (parsed.repoType !== 'bucket') {
		return;
	}
	if (params.create_pr || params.description !== undefined || params.parent_commit !== undefined) {
		throw new Error('pull requests, descriptions, and parent commits are not supported for bucket writes.');
	}
}

function decodeBase64(value: string): Uint8Array {
	const compact = value.replace(/\s/g, '');
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
		throw new Error('base64 must be valid standard base64.');
	}
	return Buffer.from(compact, 'base64');
}

function blobFromBytes(bytes: Uint8Array): Blob {
	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	return new Blob([buffer]);
}

function buildWriteResult(
	params: HfFsWriteParams,
	parsed: ParsedRepoHfUri,
	message: string,
	output: CommitOutput | undefined,
	options: { bytes?: number; branch?: string }
): HfFsWriteResult {
	return {
		uri: params.uri,
		op: params.op,
		repo: parsed.repoId,
		repo_type: parsed.repoType,
		path: parsed.path,
		...(options.bytes !== undefined ? { bytes: options.bytes } : {}),
		...(options.branch ? { branch: options.branch } : {}),
		message,
		...(output?.commit
			? {
					commit: {
						oid: output.commit.oid,
						url: output.commit.url,
					},
				}
			: {}),
		...(output?.pullRequestUrl ? { pull_request_url: output.pullRequestUrl } : {}),
	};
}

function inlineCode(value: string): string {
	return `\`${escapeMarkdown(value)}\``;
}
