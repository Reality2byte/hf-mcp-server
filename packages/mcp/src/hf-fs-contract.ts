import { z } from 'zod';

export const HF_FS_OPERATIONS = ['ls', 'cat', 'stat', 'find', 'search'] as const;
export const HF_FS_ENTRY_TYPES = ['file', 'dir', 'repo', 'bucket', 'collection', 'paper', 'link'] as const;
export const HF_FS_SEARCH_SORTS = [
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

export type HfFsOperation = (typeof HF_FS_OPERATIONS)[number];
export type HfFsEntryType = (typeof HF_FS_ENTRY_TYPES)[number];
export type HfFsSort = (typeof HF_FS_SEARCH_SORTS)[number];

export interface HfFsParams {
	op: HfFsOperation;
	uri: string;
	glob?: string;
	recursive?: boolean;
	entry_type?: HfFsEntryType;
	name?: string;
	path?: string;
	query?: string;
	sort?: HfFsSort;
	max_bytes?: number;
	offset?: number;
	limit?: number;
}

export const HF_FS_DESCRIPTION = `Navigate Hugging Face resources with ls, cat, find, stat, and search over hf:// URIs. Roots: hf://models, hf://datasets, hf://spaces, hf://buckets, hf://collections, hf://papers. For papers, ls hf://papers/ARXIV_ID to discover related resources; cat hf://papers/ARXIV_ID/paper.md or metadata.json.

Grammar; each token below is one args array element:
  ls     URI [(-R|-r|--recursive)] [--glob GLOB]
             [(-type|--type|--entry-type) TYPE] [--sort SORT] [--limit N]
  cat    URI [--offset N] [--max-bytes N]
  stat   URI
  find   URI [(-name|--name) GLOB] [(-path|--path) GLOB]
             [(-type|--type|--entry-type) TYPE] [--limit N]
  search URI QUERY [(-type|--type|--entry-type) TYPE] [--sort SORT] [--limit N]

TYPE = file|dir|repo|bucket|collection|paper|link.
Type aliases: f=file, d=dir, l=link, model|dataset|space=repo.
SORT = createdAt|downloads|likes|lastModified|likes30d|trendingScore|mainSize|id|trending|upvotes.
URI starts with hf://. QUERY and GLOB are each one string token.
Search URI: hf://models|datasets|spaces[/OWNER], hf://collections[/OWNER], or exactly hf://papers; not hf://.
Trending listings: ls hf://models/trending, hf://datasets/trending, or hf://spaces/trending. They return up to 20 entries.
Trending paths imply trending order; --sort trending|trendingScore is redundant but valid.
Trending papers: ls hf://papers/trending.
TYPE filters mixed results; omit it when the URI already fixes the result type.
Limits and path-specific behavior are documented at hf://README.md.
Omit --limit and --sort unless the request asks for a cap, ordering, or exhaustive results.
No pipes, redirects, shell expansion, or multiple commands.`;

export const HF_FS_SCHEMA = z.object({
	cmd: z.enum(HF_FS_OPERATIONS).describe('Command to execute.'),
	args: z.array(z.string()).describe('Command arguments; each array item is one grammar token.'),
});

export type HfFsRequest = z.input<typeof HF_FS_SCHEMA>;

export interface ParsedHfFsRequest {
	params: HfFsParams;
	warnings: string[];
}

type FlagKind = 'bool' | 'int' | 'string' | 'type';
type ParamKey = Exclude<keyof HfFsParams, 'op' | 'uri'>;
type Flag = readonly [ParamKey, FlagKind];

const TYPE_ALIASES: Readonly<Record<string, HfFsEntryType>> = {
	f: 'file',
	d: 'dir',
	l: 'link',
	model: 'repo',
	dataset: 'repo',
	space: 'repo',
};

const LS_FLAGS: Readonly<Record<string, Flag>> = {
	'-R': ['recursive', 'bool'],
	'-r': ['recursive', 'bool'],
	'--recursive': ['recursive', 'bool'],
	'--glob': ['glob', 'string'],
	'-type': ['entry_type', 'type'],
	'--type': ['entry_type', 'type'],
	'--entry-type': ['entry_type', 'type'],
	'--sort': ['sort', 'string'],
	'--limit': ['limit', 'int'],
};

const CAT_FLAGS: Readonly<Record<string, Flag>> = {
	'--max-bytes': ['max_bytes', 'int'],
	'--offset': ['offset', 'int'],
};

const FIND_FLAGS: Readonly<Record<string, Flag>> = {
	'-name': ['name', 'string'],
	'--name': ['name', 'string'],
	'-path': ['path', 'string'],
	'--path': ['path', 'string'],
	'-type': ['entry_type', 'type'],
	'--type': ['entry_type', 'type'],
	'--entry-type': ['entry_type', 'type'],
	'--limit': ['limit', 'int'],
};

const SEARCH_FLAGS: Readonly<Record<string, Flag>> = {
	'--query': ['query', 'string'],
	'-type': ['entry_type', 'type'],
	'--type': ['entry_type', 'type'],
	'--entry-type': ['entry_type', 'type'],
	'--sort': ['sort', 'string'],
	'--limit': ['limit', 'int'],
};

const FLAGS: Readonly<Record<HfFsOperation, Readonly<Record<string, Flag>>>> = {
	ls: LS_FLAGS,
	cat: CAT_FLAGS,
	stat: {},
	find: FIND_FLAGS,
	search: SEARCH_FLAGS,
};

export function parseHfFsRequest(request: HfFsRequest): ParsedHfFsRequest {
	const values = request.args[0] === request.cmd ? request.args.slice(1) : [...request.args];
	if (values.length === 0) {
		throw new Error(`EINVAL: ${request.cmd} requires an hf:// URI`);
	}

	const uri = values[0];
	if (!uri?.startsWith('hf://')) {
		throw new Error('EINVAL: URI must start with hf://');
	}

	const params: HfFsParams = { op: request.cmd, uri };
	const flags = FLAGS[request.cmd];
	let index = 1;

	if (request.cmd === 'search' && index < values.length && flags[values[index] ?? ''] === undefined) {
		params.query = values[index];
		index += 1;
	}

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
			params.recursive = true;
			index += 1;
			continue;
		}

		const value = values[index + 1];
		if (value === undefined) {
			throw new Error(`EINVAL: ${token} requires a value`);
		}
		setOption(params, key, kind, token, value);
		index += 2;
	}

	validateParsedParams(params);
	return softenParsedParams(params);
}

function setOption(
	params: HfFsParams,
	key: ParamKey,
	kind: Exclude<FlagKind, 'bool'>,
	token: string,
	value: string
): void {
	switch (kind) {
		case 'int': {
			if (!/^-?\d+$/.test(value)) {
				throw new Error(`EINVAL: ${token} requires an integer`);
			}
			const parsed = Number(value);
			if (!Number.isSafeInteger(parsed)) {
				throw new Error(`EINVAL: ${token} requires a safe integer`);
			}
			if (key === 'max_bytes') params.max_bytes = parsed;
			else if (key === 'offset') params.offset = parsed;
			else if (key === 'limit') params.limit = parsed;
			return;
		}
		case 'type':
			params.entry_type = TYPE_ALIASES[value] ?? (value as HfFsEntryType);
			return;
		case 'string':
			if (key === 'glob') params.glob = value;
			else if (key === 'name') params.name = value;
			else if (key === 'path') params.path = value;
			else if (key === 'query') params.query = value;
			else if (key === 'sort') params.sort = value as HfFsSort;
	}
}

function validateParsedParams(params: HfFsParams): void {
	if (params.op === 'search' && !params.query) {
		throw new Error('EINVAL: search requires a positional query or --query');
	}
	if (params.op === 'search' && !validSearchUri(params.uri)) {
		throw new Error(
			'EINVAL: search requires hf://models|datasets|spaces[/OWNER], hf://collections[/OWNER], or exactly hf://papers'
		);
	}
	if (params.entry_type !== undefined && !HF_FS_ENTRY_TYPES.includes(params.entry_type)) {
		throw new Error(`EINVAL: invalid entry type: ${params.entry_type}`);
	}
	if (params.sort !== undefined && !HF_FS_SEARCH_SORTS.includes(params.sort)) {
		throw new Error(`EINVAL: invalid sort: ${params.sort}`);
	}
	if (params.max_bytes !== undefined && (params.max_bytes < 0 || params.max_bytes > 80_000)) {
		throw new Error('EINVAL: max_bytes must be between 0 and 80000');
	}
	if (params.offset !== undefined && params.offset < 0) {
		throw new Error('EINVAL: offset must be non-negative');
	}
	if (params.limit !== undefined) {
		const max = params.op === 'search' ? 1000 : isRepoTrendingUri(params.uri) ? 20 : 10_000;
		if (params.limit < 1 || params.limit > max) {
			throw new Error(`EINVAL: limit must be between 1 and ${max.toString()} for this command`);
		}
	}
}

function softenParsedParams(params: HfFsParams): ParsedHfFsRequest {
	const warnings: string[] = [];
	if (!isRepoTrendingUri(params.uri) || params.op !== 'ls') {
		return { params, warnings };
	}

	// Tolerate safe, unambiguous model-generated variants without weakening command semantics.
	if (params.sort === 'trending' || params.sort === 'trendingScore') {
		warnings.push(`Ignored --sort ${params.sort} because ${params.uri} already implies trending order.`);
		delete params.sort;
	}
	if (params.entry_type === 'repo') {
		warnings.push(`Ignored --type repo because ${params.uri} contains only repositories.`);
		delete params.entry_type;
	}
	return { params, warnings };
}

function validSearchUri(uri: string): boolean {
	if (uri === 'hf://papers') {
		return true;
	}
	return /^hf:\/\/(?:models|datasets|spaces|collections)(?:\/[^/]+)?$/.test(uri) && !isRepoTrendingUri(uri);
}

export function isRepoTrendingUri(uri: string): boolean {
	return /^hf:\/\/(?:models|datasets|spaces)\/trending$/.test(uri);
}
