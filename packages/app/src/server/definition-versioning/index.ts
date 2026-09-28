import { createHash } from 'node:crypto';
import {
	ProtocolError,
	ProtocolErrorCode,
	SUPPORTED_PROTOCOL_VERSIONS,
	type McpServer,
	type Tool,
	type RequestTypeMap,
	type HandlerResultTypeMap,
	type ServerContext,
	type RequestMethod,
} from '@modelcontextprotocol/server';
import { recordCheckedCall, recordVersionedDiscovery, recordVersionedList } from './stats.js';

export {
	definitionVersioningCacheHints,
	definitionVersioningPolicy,
	definitionVersionsTestEnabled,
	setDefinitionVersionsTestSalt,
	type DefinitionVersioningPolicy,
} from './policy.js';
export { definitionVersioningStats, resetDefinitionVersioningStats } from './stats.js';

export const DEFINITION_VERSIONS = 'huggingface.co/definition-versions';
export const KNOWN_DEFINITION_VERSIONS = 'huggingface.co/known-definition-versions';
/**
 * Application error code for a definition-version mismatch. Outside JSON-RPC's
 * reserved range (-32768..-32000), so it cannot collide with protocol codes.
 */
export const DEFINITION_VERSION_MISMATCH = -32987;

export interface DefinitionVersions {
	tools: string;
	instructions: string;
}

const TARGETS = ['tools', 'instructions'] as const satisfies readonly (keyof DefinitionVersions)[];

// Canonicalize the JSON wire representation: undefined object properties are absent,
// array order is semantic, and object keys are sorted independently of insertion order.
function canonical(value: unknown): string {
	const json: unknown = JSON.parse(JSON.stringify(value));
	function encode(item: unknown): string {
		if (Array.isArray(item)) return `[${item.map(encode).join(',')}]`;
		if (item !== null && typeof item === 'object') {
			const record = item as Record<string, unknown>;
			return `{${Object.keys(record)
				.sort()
				.map((key) => `${JSON.stringify(key)}:${encode(record[key])}`)
				.join(',')}}`;
		}
		return JSON.stringify(item);
	}
	return encode(json);
}

function digest(target: string, value: unknown, salt: string): string {
	const hash = createHash('sha256').update(`huggingface.co/definition-versioning/v1/${target}\n`);
	// A salt changes every version without changing definitions (deploy-wide
	// invalidation or test rotation). Unsalted digests keep their v1 input.
	if (salt) hash.update(`salt:${salt}\n`);
	return `sha256:${hash.update(canonical(value)).digest('hex')}`;
}

export function definitionVersions(tools: readonly Tool[], instructions?: string, salt = ''): DefinitionVersions {
	const names = new Set<string>();
	for (const tool of tools) {
		if (names.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
		names.add(tool.name);
	}
	return {
		tools: digest(
			'tools',
			[...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
			salt
		),
		instructions: digest(
			'instructions',
			instructions === undefined ? { present: false } : { present: true, value: instructions },
			salt
		),
	};
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Presence of the key (any value) on a tools/call. */
export function hasKnownDefinitionVersions(request: unknown): boolean {
	if (!record(request) || request.method !== 'tools/call' || !record(request.params)) return false;
	return record(request.params._meta) && Object.hasOwn(request.params._meta, KNOWN_DEFINITION_VERSIONS);
}

/**
 * Known versions are advisory hints. Unknown targets (e.g. `prompts`, valid in the
 * SEP but not versioned here) and non-string values make no claim and are ignored;
 * a non-object value is treated as no hint. Any string is compared for equality, so
 * an unrecognized version is simply stale.
 */
function parseKnownDefinitionVersions(meta: Record<string, unknown> | undefined): Partial<DefinitionVersions> {
	const value = meta?.[KNOWN_DEFINITION_VERSIONS];
	if (!record(value)) return {};
	const known: Partial<DefinitionVersions> = {};
	for (const target of TARGETS) {
		const version = value[target];
		if (typeof version === 'string') known[target] = version;
	}
	return known;
}

type Handler<M extends RequestMethod> = (
	request: RequestTypeMap[M],
	ctx: ServerContext
) => HandlerResultTypeMap[M] | Promise<HandlerResultTypeMap[M]>;

export interface DefinitionVersioningOptions {
	/** Mixed into every digest; empty means unsalted. Fixed for the server instance. */
	salt?: string;
}

/** Install before first registerTool; call the returned finalizer after registration. */
export function installDefinitionVersioning(
	server: McpServer,
	instructions?: string,
	options: DefinitionVersioningOptions = {}
): () => void {
	const low = server.server;
	const register = low.setRequestHandler.bind(low);
	const salt = options.salt ?? '';
	let hasToolHandlers = false;
	let list: Handler<'tools/list'> = () => ({ tools: [] });
	const snapshot = async (ctx: ServerContext) =>
		definitionVersions((await list({ method: 'tools/list' }, ctx)).tools, instructions, salt);

	// The cast is confined to the overload-dispatch seam; intercepted handlers are
	// typed by method, and custom-schema registrations pass through untouched.
	low.setRequestHandler = ((method: string, handler: unknown, customHandler?: unknown) => {
		if (customHandler !== undefined) {
			Reflect.apply(register, low, [method, handler, customHandler]);
		} else if (method === 'tools/list') {
			hasToolHandlers = true;
			list = handler as Handler<'tools/list'>;
			register('tools/list', async (request, ctx) => {
				const result = await list(request, ctx);
				// Current listings are unpaginated: result.tools is the complete registry.
				// Pagination would require a collection-wide versioning strategy.
				const versions = { tools: definitionVersions(result.tools, undefined, salt).tools };
				recordVersionedList();
				return { ...result, _meta: { ...result._meta, [DEFINITION_VERSIONS]: versions } };
			});
		} else if (method === 'tools/call') {
			const call = handler as Handler<'tools/call'>;
			register('tools/call', async (request, ctx) => {
				const known = parseKnownDefinitionVersions(request.params._meta);
				if (Object.keys(known).length) {
					const current = await snapshot(ctx);
					const stale = TARGETS.filter((target) => known[target] !== undefined && known[target] !== current[target]);
					recordCheckedCall(stale);
					if (stale.length) {
						// Name the stale targets, but do not hand out replacement versions:
						// clients must refetch the definitions a version describes.
						throw new ProtocolError(
							DEFINITION_VERSION_MISMATCH,
							'Definition versions changed; refresh definitions before retrying.',
							{ stale }
						);
					}
				}
				return call(request, ctx);
			});
		} else if (method === 'server/discover') {
			const discover = handler as Handler<'server/discover'>;
			register('server/discover', async (request, ctx) => {
				const result = await discover(request, ctx);
				const current = definitionVersions(
					(await list({ method: 'tools/list' }, ctx)).tools,
					result.instructions,
					salt
				);
				// Calls are checked against the configured instructions. Advertise an
				// instructions version only when discovery returns that same text, so a
				// divergent handler cannot cause every checked call to be rejected.
				const versions: Partial<DefinitionVersions> =
					result.instructions === instructions ? current : { tools: current.tools };
				recordVersionedDiscovery();
				return { ...result, _meta: { ...result._meta, [DEFINITION_VERSIONS]: versions } };
			});
		} else {
			Reflect.apply(register, low, [method, handler]);
		}
	}) as typeof low.setRequestHandler;

	// Matches SDK 2.0's constructor discovery response. HTTP serving entries later
	// install their own discover handler, which the adapter above also decorates.
	low.setRequestHandler('server/discover', () => ({
		supportedVersions: SUPPORTED_PROTOCOL_VERSIONS.filter((version) => version >= '2026-07-28'),
		capabilities: low.getCapabilities(),
		...(instructions !== undefined ? { instructions } : {}),
	}));

	return () => {
		// With every tool disabled by configuration, registerTool is never called.
		// Install empty-registry handlers only after registration, so we do not
		// conflict with the high-level SDK's assertCanSetRequestHandler checks.
		if (hasToolHandlers) return;
		low.registerCapabilities({ tools: { listChanged: false } });
		low.setRequestHandler('tools/list', () => ({ tools: [] }));
		low.setRequestHandler('tools/call', (request) => {
			throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool ${request.params.name} not found`);
		});
	};
}
