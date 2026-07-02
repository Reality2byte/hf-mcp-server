import { Buffer } from 'node:buffer';
import { deleteFile, uploadFile } from '@huggingface/hub';
import type { CommitOutput } from '@huggingface/hub';
import { z } from 'zod';
import { type ParsedRepoHfUri, parseHfFsUri } from './hf-fs.js';
import { escapeMarkdown, formatBytes, NO_TOKEN_INSTRUCTIONS } from './utilities.js';

const HF_FS_WRITE_OPERATIONS = ['put', 'rm'] as const;

export const HF_FS_WRITE_TOOL_ID = 'hf_fs_write' as const;

function createHfFsWriteSchema() {
	return z.object({
		op: z.enum(HF_FS_WRITE_OPERATIONS),
		uri: z
			.string()
			.min(1)
			.describe('Hugging Face file URI in the form hf://models|datasets|spaces|buckets/OWNER/NAME/PATH.'),
		text: z.string().optional().describe('Text content to write. Use only with op=put.'),
		base64: z.string().optional().describe('Base64-encoded file bytes to write. Use only with op=put.'),
		message: z.string().min(1).optional().describe('Optional commit message/title.'),
		branch: z.string().min(1).optional().describe('Optional target branch for repo writes. Not supported for buckets.'),
	});
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
	});
}

export const HF_FS_WRITE_TOOL_CONFIG = {
	name: HF_FS_WRITE_TOOL_ID,
	title: 'Hugging Face File Writes',
	description: 'Write or remove files on Hugging Face',
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

export type HfFsWriteParams = z.input<typeof HF_FS_WRITE_TOOL_CONFIG.schema>;
export type HfFsWriteOperation = (typeof HF_FS_WRITE_OPERATIONS)[number];

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
			description: 'Write or remove files in a Hugging Face repo or bucket.',
			schema: createHfFsWriteSchema(),
		};
	}

	async run(params: HfFsWriteParams): Promise<HfFsWriteResult> {
		if (!this.accessToken) {
			throw new Error(NO_TOKEN_INSTRUCTIONS);
		}

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
		const output = await uploadFile({
			accessToken,
			repo: parsed.repo,
			file: {
				path: parsed.path,
				content: blobFromBytes(content),
			},
			commitTitle: message,
			...(branch ? { branch } : {}),
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
		const output = await deleteFile({
			accessToken,
			repo: parsed.repo,
			path: parsed.path,
			commitTitle: message,
			...(branch ? { branch } : {}),
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
		throw new Error('text and base64 are only valid with op=put.');
	}

	const hasText = params.text !== undefined;
	const hasBase64 = params.base64 !== undefined;
	if (hasText === hasBase64) {
		throw new Error('put requires exactly one of text or base64.');
	}

	if (hasText) {
		return new TextEncoder().encode(params.text);
	}
	return decodeBase64(params.base64 ?? '');
}

function rejectPutContent(params: HfFsWriteParams): void {
	if (params.text !== undefined || params.base64 !== undefined) {
		throw new Error('text and base64 are only valid with op=put.');
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
	};
}

function inlineCode(value: string): string {
	return `\`${escapeMarkdown(value)}\``;
}
