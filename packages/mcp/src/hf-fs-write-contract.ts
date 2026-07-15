import { z } from 'zod';

export const HF_FS_WRITE_OPERATIONS = ['put', 'rm'] as const;

export type HfFsWriteOperation = (typeof HF_FS_WRITE_OPERATIONS)[number];

export interface HfFsWriteParams {
	op: HfFsWriteOperation;
	uri: string;
	content?: string;
	base64?: boolean;
	message?: string;
	description?: string;
	branch?: string;
	create_pr?: boolean;
	parent_commit?: string;
}

export const HF_FS_WRITE_DESCRIPTION = `Write or remove files in Hugging Face repositories and buckets.

Grammar; each token below is one args array element:
  put URI [--base64] [(-m|--message) MESSAGE] [--description DESCRIPTION]
          [--branch BRANCH] [--create-pr] [--parent-commit SHA]
  rm  URI [(-m|--message) MESSAGE] [--description DESCRIPTION]
          [--branch BRANCH] [--create-pr] [--parent-commit SHA]

URI must be an hf://models|datasets|spaces|buckets/OWNER/NAME/PATH file URI.
For put, provide file data in the separate content field. Content is UTF-8 text unless --base64 is present.
Use --create-pr to propose a change when direct repository writes are unavailable or undesirable.
Branches, pull requests, descriptions, and parent commits are not supported for buckets.
A URI '@revision' and --branch are equivalent; do not specify conflicting values.
--parent-commit must be a 40-character Git commit SHA and prevents overwriting concurrent changes.
No pipes, redirects, shell expansion, or multiple commands.`;

export const HF_FS_WRITE_SCHEMA = z.object({
	cmd: z.enum(HF_FS_WRITE_OPERATIONS).describe('Command to execute.'),
	args: z.array(z.string()).describe('Command arguments; each array item is one grammar token.'),
	content: z
		.string()
		.optional()
		.describe('File content for put. UTF-8 text by default; base64 when args includes --base64.'),
});

export type HfFsWriteRequest = z.input<typeof HF_FS_WRITE_SCHEMA>;

type FlagKind = 'bool' | 'string' | 'sha';
type ParamKey = Exclude<keyof HfFsWriteParams, 'op' | 'uri' | 'content'>;
type Flag = readonly [ParamKey, FlagKind];

const COMMON_FLAGS: Readonly<Record<string, Flag>> = {
	'-m': ['message', 'string'],
	'--message': ['message', 'string'],
	'--description': ['description', 'string'],
	'--branch': ['branch', 'string'],
	'--create-pr': ['create_pr', 'bool'],
	'--parent-commit': ['parent_commit', 'sha'],
};

const FLAGS: Readonly<Record<HfFsWriteOperation, Readonly<Record<string, Flag>>>> = {
	put: {
		...COMMON_FLAGS,
		'--base64': ['base64', 'bool'],
	},
	rm: COMMON_FLAGS,
};

export function parseHfFsWriteRequest(request: HfFsWriteRequest): HfFsWriteParams {
	const values = request.args[0] === request.cmd ? request.args.slice(1) : [...request.args];
	if (values.length === 0) {
		throw new Error(`EINVAL: ${request.cmd} requires an hf:// file URI`);
	}

	const uri = values[0];
	if (!uri?.startsWith('hf://')) {
		throw new Error('EINVAL: URI must start with hf://');
	}

	const params: HfFsWriteParams = {
		op: request.cmd,
		uri,
		...(request.content !== undefined ? { content: request.content } : {}),
	};
	const flags = FLAGS[request.cmd];
	let index = 1;

	while (index < values.length) {
		const token = values[index];
		const flag = token === undefined ? undefined : flags[token];
		if (!token || !flag) {
			throw new Error(`EINVAL: unexpected argument for ${request.cmd}: ${token ?? ''}`);
		}

		const [key, kind] = flag;
		if (params[key] !== undefined) {
			throw new Error(`EINVAL: duplicate option for ${key}: ${token}`);
		}
		if (kind === 'bool') {
			setBooleanOption(params, key);
			index += 1;
			continue;
		}

		const value = values[index + 1];
		if (value === undefined) {
			throw new Error(`EINVAL: ${token} requires a value`);
		}
		if (kind === 'string' && value.length === 0) {
			throw new Error(`EINVAL: ${token} requires a non-empty value`);
		}
		if (kind === 'sha' && !/^[0-9A-Fa-f]{40}$/.test(value)) {
			throw new Error(`EINVAL: ${token} requires a 40-character Git commit SHA`);
		}
		setStringOption(params, key, value);
		index += 2;
	}

	if (request.cmd === 'put' && request.content === undefined) {
		throw new Error('EINVAL: put requires content');
	}
	if (request.cmd === 'rm' && request.content !== undefined) {
		throw new Error('EINVAL: content is only valid with put');
	}
	return params;
}

function setBooleanOption(params: HfFsWriteParams, key: ParamKey): void {
	if (key === 'base64') params.base64 = true;
	else if (key === 'create_pr') params.create_pr = true;
}

function setStringOption(params: HfFsWriteParams, key: ParamKey, value: string): void {
	if (key === 'message') params.message = value;
	else if (key === 'description') params.description = value;
	else if (key === 'branch') params.branch = value;
	else if (key === 'parent_commit') params.parent_commit = value;
}
