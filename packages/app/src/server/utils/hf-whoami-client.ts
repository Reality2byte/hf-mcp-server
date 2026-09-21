import { fetchWithProfile, NETWORK_FETCH_PROFILES } from '@llmindset/hf-mcp/network';
import { z } from 'zod';

const HF_WHOAMI_URL = 'https://huggingface.co/api/whoami-v2';
const DEFAULT_HF_API_TIMEOUT_MS = 12_500;

const nonEmptyStringSchema = z.string().min(1);
const isoDateTimeSchema = z.iso.datetime();

const resourceGroupSchema = z.looseObject({
	id: nonEmptyStringSchema,
	name: nonEmptyStringSchema,
	role: nonEmptyStringSchema,
});

const organizationSchema = z.looseObject({
	id: nonEmptyStringSchema,
	type: z.literal('org'),
	name: nonEmptyStringSchema,
	fullname: nonEmptyStringSchema.optional(),
	plan: nonEmptyStringSchema.optional(),
	roleInOrg: nonEmptyStringSchema.optional(),
	securityRestrictions: z.array(nonEmptyStringSchema).optional(),
	resourceGroups: z.array(resourceGroupSchema).optional(),
});

const fineGrainedEntityTypeSchema = z.enum([
	'model',
	'dataset',
	'space',
	'bucket',
	'kernel',
	'collection',
	'org',
	'user',
	'resource-group',
	'oauth-app',
]);

const fineGrainedPatternSchema = z.looseObject({
	resourceType: z.literal('inference-endpoint'),
	wildcardPatterns: z.array(nonEmptyStringSchema).min(1),
});

const fineGrainedScopeSchema = z.looseObject({
	entity: z.looseObject({
		_id: nonEmptyStringSchema,
		type: fineGrainedEntityTypeSchema,
		name: nonEmptyStringSchema.optional(),
	}),
	permissions: z.array(nonEmptyStringSchema),
	patterns: z.array(fineGrainedPatternSchema).optional(),
});

const fineGrainedPermissionsSchema = z.looseObject({
	scoped: z.array(fineGrainedScopeSchema),
	global: z.array(nonEmptyStringSchema).optional(),
	canReadGatedRepos: z.boolean().optional(),
});

const accessTokenSchema = z.looseObject({
	displayName: z.string(),
	role: nonEmptyStringSchema,
	createdAt: isoDateTimeSchema,
	fineGrained: fineGrainedPermissionsSchema.optional(),
});

const authenticationSchema = z.looseObject({
	type: nonEmptyStringSchema,
	accessToken: accessTokenSchema.optional(),
	expiresAt: isoDateTimeSchema.optional(),
	resource: z.looseObject({ sub: nonEmptyStringSchema }).optional(),
});

const appScopeEntitySchema = z.looseObject({
	type: z.enum(['model', 'dataset', 'space', 'bucket', 'kernel', 'org']),
	name: nonEmptyStringSchema,
});

const appScopeSchema = z.looseObject({
	role: nonEmptyStringSchema,
	entities: z.array(z.union([appScopeEntitySchema, nonEmptyStringSchema])),
});

const userResponseSchema = z.looseObject({
	id: nonEmptyStringSchema,
	type: z.literal('user'),
	name: nonEmptyStringSchema,
	isPro: z.boolean().optional(),
	orgs: z.array(organizationSchema),
	auth: authenticationSchema,
});

const appResponseSchema = z.looseObject({
	id: nonEmptyStringSchema,
	type: z.literal('app'),
	name: nonEmptyStringSchema,
	scope: appScopeSchema.optional(),
	auth: authenticationSchema,
});

// Retain the legacy organization-principal shape accepted by the previous SDK
// type. The Hub API currently returns user or app principals from whoami-v2.
const organizationResponseSchema = z.looseObject({
	id: nonEmptyStringSchema,
	type: z.literal('org'),
	name: nonEmptyStringSchema,
	auth: authenticationSchema,
});

/**
 * Runtime contract owned by this server for the Hub API's /api/whoami-v2.
 *
 * Upstream objects are deliberately loose so additive API fields neither break
 * authentication nor become public output accidentally. The hf_whoami mapper
 * separately allowlists every field exposed through MCP.
 */
const hfWhoamiResponseSchema = z.discriminatedUnion('type', [
	userResponseSchema,
	appResponseSchema,
	organizationResponseSchema,
]);

export type HfWhoamiResponse = z.infer<typeof hfWhoamiResponseSchema>;
export type HfWhoamiAuthentication = z.infer<typeof authenticationSchema>;

export class HfWhoamiRequestError extends Error {
	readonly kind: 'http' | 'invalid_response';
	readonly statusCode: number | undefined;

	constructor(kind: 'http' | 'invalid_response', statusCode?: number) {
		super(
			kind === 'http'
				? `Hugging Face whoami request failed with status ${statusCode?.toString() ?? 'unknown'}.`
				: 'Hugging Face whoami returned an invalid response.'
		);
		this.name = 'HfWhoamiRequestError';
		this.kind = kind;
		this.statusCode = statusCode;
	}
}

function hfApiTimeoutMs(): number {
	const configured = process.env.HF_API_TIMEOUT;
	if (!configured) {
		return DEFAULT_HF_API_TIMEOUT_MS;
	}

	const parsed = Number.parseInt(configured, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_HF_API_TIMEOUT_MS;
}

export function isHfWhoamiUnauthorizedError(error: unknown): boolean {
	return error instanceof HfWhoamiRequestError && error.statusCode === 401;
}

/**
 * Calls the Hub API directly instead of relying on the narrower, stale
 * @huggingface/hub whoAmI response declarations.
 */
export async function fetchHfWhoami(accessToken: string): Promise<HfWhoamiResponse> {
	const { response } = await fetchWithProfile(HF_WHOAMI_URL, NETWORK_FETCH_PROFILES.hfHub(), {
		timeoutMs: hfApiTimeoutMs(),
		requestInit: {
			method: 'GET',
			headers: {
				Accept: 'application/json',
				Authorization: `Bearer ${accessToken}`,
			},
		},
	});

	if (!response.ok) {
		await response.body?.cancel().catch(() => undefined);
		throw new HfWhoamiRequestError('http', response.status);
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw new HfWhoamiRequestError('invalid_response');
	}

	const parsed = hfWhoamiResponseSchema.safeParse(payload);
	if (!parsed.success) {
		throw new HfWhoamiRequestError('invalid_response');
	}
	return parsed.data;
}
