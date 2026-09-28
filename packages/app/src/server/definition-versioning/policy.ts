import type { CacheHint } from '@modelcontextprotocol/server';
import { BOUQUETS } from '../../shared/bouquet-presets.js';
import { extractAuthBouquetAndMix } from '../utils/auth-utils.js';
import type {
	DefinitionVersioningStatus,
	DefinitionVersioningStats,
} from '../../shared/definition-versioning-status.js';

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_TEST_SALT_LENGTH = 128;

export interface DefinitionVersioningPolicy {
	ttlMs: number;
	/** Mixed into every digest; changes versions without changing definitions. */
	salt: string;
}

export interface PolicyEnvironment {
	/** DEFINITION_VERSIONING=off disables versions, checks and cache hints. */
	DEFINITION_VERSIONING?: string;
	/** Cache TTL for eligible tools/list and server/discover results (ms, default 5 min). */
	DEFINITION_VERSIONS_TTL_MS?: string;
	/** Deploy-wide salt; changing it invalidates every client's versions. */
	DEFINITION_VERSIONS_SALT?: string;
	/** "true" enables the runtime test salt (set via /api/definition-versions/salt). */
	DEFINITION_VERSIONS_TEST?: string;
}

// Per-process: with several replicas, each needs the same salt or versions flap.
let testSalt = '';
let testSaltUpdatedAt: string | undefined;

export function definitionVersionsTestEnabled(env: PolicyEnvironment = process.env): boolean {
	return env.DEFINITION_VERSIONS_TEST === 'true';
}

export function getDefinitionVersionsTestSalt(): string {
	return testSalt;
}

/** Sets (or, with '', clears) the runtime test salt. Throws on invalid input. */
export function setDefinitionVersionsTestSalt(value: string): void {
	if (value.length > MAX_TEST_SALT_LENGTH || !/^[\x21-\x7e]*$/.test(value)) {
		throw new RangeError(`Salt must be at most ${MAX_TEST_SALT_LENGTH} printable ASCII characters without spaces`);
	}
	testSalt = value;
	testSaltUpdatedAt = new Date().toISOString();
}

/** Dashboard status; the caller supplies the error code and stats to avoid import cycles. */
export function definitionVersioningStatus(
	errorCode: number,
	stats: DefinitionVersioningStats,
	env: PolicyEnvironment = process.env
): DefinitionVersioningStatus {
	return {
		enabled: env.DEFINITION_VERSIONING !== 'off',
		ttlMs: ttlMs(env.DEFINITION_VERSIONS_TTL_MS),
		deploySalt: env.DEFINITION_VERSIONS_SALT ?? '',
		testSalt,
		...(testSaltUpdatedAt ? { testSaltUpdatedAt } : {}),
		errorCode,
		stats,
	};
}

function ttlMs(raw: string | undefined): number {
	if (raw === undefined || raw.trim() === '') return DEFAULT_TTL_MS;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_TTL_MS;
}

/**
 * Decide whether a request gets definition versions (and cache hints).
 *
 * Versions are offered only where the complete tool list is cheap to build (no
 * per-user settings fetch; at most the cached default Gradio space):
 *  - anonymous requests: settings resolve locally (BOUQUET_FALLBACK, or the static
 *    defaults whose Gradio space metadata and schema are cached); and
 *  - a named bouquet other than `all`, with or without a token (bouquets take
 *    precedence over settings and skip settings-derived Gradio spaces).
 * An explicit gradio selection (other than `none`) always needs Space discovery.
 *
 * Everything else returns undefined: no versions, no checks (hints are ignored),
 * and the existing per-request shortcuts stay in place.
 */
export function definitionVersioningPolicy(
	headers: Record<string, string> | null,
	env: PolicyEnvironment = process.env
): DefinitionVersioningPolicy | undefined {
	if (!headers || env.DEFINITION_VERSIONING === 'off') return undefined;

	const { hfToken, bouquet, gradio } = extractAuthBouquetAndMix(headers);
	if (gradio && gradio !== 'none') return undefined;

	const namedBouquet = bouquet !== undefined && bouquet !== 'all' && Object.hasOwn(BOUQUETS, bouquet);
	if (!namedBouquet && hfToken) return undefined;

	const runtimeSalt = definitionVersionsTestEnabled(env) ? testSalt : '';
	return {
		ttlMs: ttlMs(env.DEFINITION_VERSIONS_TTL_MS),
		salt: [env.DEFINITION_VERSIONS_SALT ?? '', runtimeSalt].filter(Boolean).join('/'),
	};
}

/**
 * Cache hints for eligible requests. Always `private`: `public` means every caller
 * would get the same result, not merely that it holds no user data. An anonymous
 * tool list omits tools that require sign-in, so a signed-in caller sharing a cache
 * would be served the shorter list. (The TypeScript client also keys shared entries
 * by server name, not URL, so different bouquets would collide.) Discovery can
 * vary by client and names the user in instructions.
 */
export function definitionVersioningCacheHints(
	policy: DefinitionVersioningPolicy
): Partial<Record<'tools/list' | 'server/discover', CacheHint>> {
	return {
		'tools/list': { ttlMs: policy.ttlMs, cacheScope: 'private' },
		'server/discover': { ttlMs: policy.ttlMs, cacheScope: 'private' },
	};
}
