import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { hfWhoamiOutputSchema } from '../../../src/server/output-schemas/hf-whoami-output-schema.js';
import type { HfWhoamiAuthentication, HfWhoamiResponse } from '../../../src/server/utils/hf-whoami-client.js';
import { createHfWhoamiOutput, formatHfWhoamiMarkdown } from '../../../src/server/utils/hf-whoami.js';

function oauthToken(scopes: string[]): string {
	const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
	const payload = Buffer.from(JSON.stringify({ scope: scopes })).toString('base64url');
	return `hf_oauth_${header}.${payload}.signature`;
}

function baseUser(auth: HfWhoamiAuthentication): HfWhoamiResponse {
	return {
		id: 'user-id',
		type: 'user',
		name: 'alice',
		fullname: 'Alice Example',
		email: 'alice@example.com',
		emailVerified: true,
		isPro: true,
		canPay: true,
		avatarUrl: 'https://cdn.example/alice.png',
		periodEnd: null,
		billingMode: 'prepaid',
		orgs: [
			{
				id: 'org-id',
				type: 'org',
				name: 'example-org',
				fullname: 'Example Org',
				email: null,
				canPay: true,
				avatarUrl: 'https://cdn.example/org.png',
				periodEnd: null,
				plan: 'team',
				roleInOrg: 'no_access',
				securityRestrictions: ['sso'],
				resourceGroups: [{ id: 'group-id', name: 'Research', role: 'custom-research-role' }],
			},
		],
		auth,
	};
}

describe('hf_whoami output', () => {
	it('returns complete fine-grained personal-token permissions in equivalent JSON and Markdown', () => {
		const user = baseUser({
			type: 'access_token',
			accessToken: {
				displayName: 'Do not expose',
				role: 'fineGrained',
				createdAt: '2026-08-04T12:00:00.000Z',
				fineGrained: {
					scoped: [
						{
							entity: { _id: 'model-id', type: 'model', name: 'org/private-model' },
							permissions: ['readRepoContent', 'writeRepoContent'],
							patterns: [
								{
									resourceType: 'inference-endpoint',
									wildcardPatterns: ['gpt2-*', 'private-*'],
								},
							],
						},
						{
							entity: { _id: 'resource-group-id', type: 'resource-group' },
							permissions: ['readRepoContent'],
						},
					],
					global: ['writeDiscussion'],
					canReadGatedRepos: true,
				},
			},
		});
		const result = createHfWhoamiOutput(user, 'hf_personal-token', 'anonymous guidance');
		const markdown = formatHfWhoamiMarkdown(result);

		expect(hfWhoamiOutputSchema.parse(result)).toEqual(result);
		expect(result).toMatchObject({
			status: 'authenticated',
			account: {
				id: 'user-id',
				type: 'user',
				name: 'alice',
				url: 'https://huggingface.co/alice',
				is_pro: true,
			},
			credential: {
				type: 'personal_access_token',
				role: 'fine_grained',
				created_at: '2026-08-04T12:00:00.000Z',
				permissions: {
					scoped: [
						{
							entity: { id: 'model-id', type: 'model', name: 'org/private-model' },
							permissions: ['readRepoContent', 'writeRepoContent'],
							restrictions: [
								{
									resource_type: 'inference_endpoint',
									patterns: ['gpt2-*', 'private-*'],
								},
							],
						},
						{
							entity: { id: 'resource-group-id', type: 'resource_group' },
							permissions: ['readRepoContent'],
						},
					],
					global: ['writeDiscussion'],
					can_read_gated_repos: true,
				},
			},
			organizations: [
				{
					id: 'org-id',
					name: 'example-org',
					display_name: 'Example Org',
					plan: 'team',
					role: 'no_access',
					security_restrictions: ['sso'],
					resource_groups: [{ id: 'group-id', name: 'Research', role: 'custom-research-role' }],
				},
			],
		});
		expect(result).not.toHaveProperty('identity');
		expect(result).not.toHaveProperty('authentication');
		expect(markdown).toContain('Authenticated as [@alice]');
		expect(markdown).toContain('Role:** `fine_grained`');
		expect(markdown).toContain('Model: `org/private-model`');
		expect(markdown).toContain('`writeRepoContent`');
		expect(markdown).toContain('Resource name restrictions');
		expect(markdown).toContain('`gpt2-*`');
		expect(markdown).toContain('`private-*`');
		expect(markdown).toContain('Resource Group');
		expect(markdown).toContain('Name:** unavailable');
		expect(markdown).toContain('`writeDiscussion`');
		expect(markdown).toContain('Can read accessible public gated repositories:** yes');
		expect(markdown).toContain('Example Org');
		expect(JSON.stringify(result)).not.toContain('Alice Example');
		expect(JSON.stringify(result)).not.toContain('alice@example.com');
		expect(JSON.stringify(result)).not.toContain('Do not expose');
		expect(JSON.stringify(result)).not.toContain('hf_personal-token');
	});

	it('preserves fine-grained permissions when canReadGatedRepos is not returned', () => {
		const result = createHfWhoamiOutput(
			baseUser({
				type: 'access_token',
				accessToken: {
					displayName: 'Fine-grained token',
					role: 'fineGrained',
					createdAt: '2026-08-04T12:00:00.000Z',
					fineGrained: {
						scoped: [
							{
								entity: { _id: 'model-id', type: 'model', name: 'org/private-model' },
								permissions: ['readRepoContent'],
							},
						],
						global: ['writeDiscussion'],
					},
				},
			}),
			'hf_personal-token',
			'anonymous guidance'
		);
		const markdown = formatHfWhoamiMarkdown(result);

		expect(result.credential).toMatchObject({
			type: 'personal_access_token',
			role: 'fine_grained',
			permissions: {
				scoped: [
					{
						entity: { id: 'model-id', type: 'model', name: 'org/private-model' },
						permissions: ['readRepoContent'],
					},
				],
				global: ['writeDiscussion'],
			},
		});
		expect(result.credential).not.toHaveProperty('permissions.can_read_gated_repos');
		expect(markdown).toContain('`readRepoContent`');
		expect(markdown).not.toContain('Can read accessible public gated repositories');
	});

	it('preserves scoped permissions when global permissions are not returned', () => {
		const result = createHfWhoamiOutput(
			baseUser({
				type: 'access_token',
				accessToken: {
					displayName: 'Fine-grained token',
					role: 'fineGrained',
					createdAt: '2026-08-04T12:00:00.000Z',
					fineGrained: {
						scoped: [
							{
								entity: { _id: 'model-id', type: 'model', name: 'org/private-model' },
								permissions: ['readRepoContent'],
							},
						],
						canReadGatedRepos: false,
					},
				},
			}),
			'hf_personal-token',
			'anonymous guidance'
		);
		const markdown = formatHfWhoamiMarkdown(result);

		expect(result.credential).toMatchObject({
			type: 'personal_access_token',
			role: 'fine_grained',
			permissions: {
				scoped: [
					{
						entity: { id: 'model-id', type: 'model', name: 'org/private-model' },
						permissions: ['readRepoContent'],
					},
				],
				can_read_gated_repos: false,
			},
		});
		expect(result.credential).not.toHaveProperty('permissions.global');
		expect(markdown).toContain('global permission details were not returned');
	});

	it('keeps a fine-grained credential usable when permission metadata is unavailable', () => {
		const result = createHfWhoamiOutput(
			baseUser({
				type: 'access_token',
				accessToken: {
					displayName: 'Fine-grained token',
					role: 'fineGrained',
					createdAt: '2026-08-04T12:00:00.000Z',
				},
			}),
			'hf_personal-token',
			'anonymous guidance'
		);

		expect(result.credential).toEqual({
			type: 'personal_access_token',
			role: 'fine_grained',
			created_at: '2026-08-04T12:00:00.000Z',
		});
		expect(formatHfWhoamiMarkdown(result)).toContain('Fine-grained permission details were not returned by the Hub.');
	});

	it.each(['read', 'write'] as const)('reports a %s token role without fabricating expanded permissions', (role) => {
		const result = createHfWhoamiOutput(
			baseUser({
				type: 'access_token',
				accessToken: {
					displayName: 'CLI token',
					role,
					createdAt: '2026-08-04T12:00:00.000Z',
				},
			}),
			'hf_personal-token',
			'anonymous guidance'
		);
		const markdown = formatHfWhoamiMarkdown(result);

		expect(result).toMatchObject({
			status: 'authenticated',
			credential: {
				type: 'personal_access_token',
				role,
			},
		});
		expect(result.credential).not.toHaveProperty('permissions');
		expect(markdown).toContain(`Role:** \`${role}\``);
		expect(markdown).toContain('does not provide an expanded permission list');
		expect(markdown).not.toContain('OAuth scopes');
	});

	it('does not expose an unknown authentication subtype or reinterpret its backing token as a PAT', () => {
		const result = createHfWhoamiOutput(
			baseUser({
				type: 'unknown_authentication_subtype',
				expiresAt: '2027-08-05T00:00:00.000Z',
				accessToken: {
					displayName: 'Sensitive token metadata',
					role: 'write',
					createdAt: '2026-08-04T12:00:00.000Z',
				},
			}),
			'hf_unknown_credential',
			'anonymous guidance'
		);

		expect(result.credential).toEqual({
			type: 'other',
			expires_at: '2027-08-05T00:00:00.000Z',
		});
		expect(JSON.stringify(result)).not.toContain('unknown_authentication_subtype');
		expect(JSON.stringify(result)).not.toContain('Sensitive token metadata');
		expect(formatHfWhoamiMarkdown(result)).toContain('Type:** other authenticated credential');
	});

	it('does not expose or reinterpret unsupported access-token roles', () => {
		const result = createHfWhoamiOutput(
			baseUser({
				type: 'access_token',
				accessToken: {
					displayName: 'Sensitive token metadata',
					role: 'unsupported_role',
					createdAt: '2026-08-04T12:00:00.000Z',
				},
			}),
			'hf_unknown-token',
			'anonymous guidance'
		);

		expect(result.credential).toEqual({
			type: 'other',
		});
		expect(JSON.stringify(result)).not.toContain('unsupported_role');
		expect(JSON.stringify(result)).not.toContain('Sensitive token metadata');
	});

	it('reports only scopes granted to the current OAuth credential', () => {
		const token = oauthToken(['openid', 'profile', 'read-mcp']);
		const result = createHfWhoamiOutput(
			baseUser({
				type: 'oauth',
				expiresAt: '2027-08-05T00:00:00.000Z',
			}),
			token,
			'anonymous guidance'
		);
		const markdown = formatHfWhoamiMarkdown(result);

		expect(result).toMatchObject({
			status: 'authenticated',
			credential: {
				type: 'oauth',
				expires_at: '2027-08-05T00:00:00.000Z',
				scopes: ['openid', 'profile', 'read-mcp'],
			},
		});
		expect(markdown).toContain('Granted OAuth scopes');
		expect(markdown).toContain('`read-mcp`');
		expect(markdown).not.toContain('available for this MCP resource');
		expect(JSON.stringify(result)).not.toContain(token);
	});

	it('omits OAuth scopes when the current token claim cannot be read', () => {
		const result = createHfWhoamiOutput(baseUser({ type: 'oauth' }), 'not-a-jwt', 'anonymous guidance');
		const markdown = formatHfWhoamiMarkdown(result);

		expect(result.credential).toEqual({ type: 'oauth' });
		expect(result.credential).not.toHaveProperty('scopes');
		expect(markdown).toContain('scope claim could not be read');
	});

	it('uses an empty OAuth scope array when the current token claim is known empty', () => {
		const result = createHfWhoamiOutput(baseUser({ type: 'oauth' }), oauthToken([]), 'anonymous guidance');

		expect(result.credential).toEqual({ type: 'oauth', scopes: [] });
		expect(formatHfWhoamiMarkdown(result)).toContain('This OAuth token has no explicit scopes.');
	});

	it('reports typed and legacy application-token entities in a flat credential', () => {
		const app = {
			id: 'app-id',
			type: 'app',
			name: 'automation-app',
			scope: {
				role: 'read',
				entities: [{ type: 'bucket', name: 'org/bucket' }, { type: 'kernel', name: 'org/kernel' }, 'legacy/entity'],
			},
			auth: { type: 'app_token' },
		} satisfies HfWhoamiResponse;
		const result = createHfWhoamiOutput(app, 'hf_app-token', 'anonymous guidance');
		const markdown = formatHfWhoamiMarkdown(result);

		expect(result).toMatchObject({
			status: 'authenticated',
			account: { id: 'app-id', type: 'app', name: 'automation-app' },
			credential: {
				type: 'app_token',
				role: 'read',
				entities: [
					{ type: 'bucket', name: 'org/bucket' },
					{ type: 'kernel', name: 'org/kernel' },
					{ name: 'legacy/entity' },
				],
			},
		});
		expect(markdown).toContain('Type:** application token');
		expect(markdown).toContain('Bucket:** `org/bucket`');
		expect(markdown).toContain('Kernel:** `org/kernel`');
		expect(markdown).toContain('Entity:** `legacy/entity`');
	});

	it('represents authenticated non-token methods without inventing token permissions', () => {
		const result = createHfWhoamiOutput(
			baseUser({ type: 'alternate_authentication_method' }),
			undefined,
			'anonymous guidance'
		);
		const markdown = formatHfWhoamiMarkdown(result);

		expect(result).toMatchObject({
			status: 'authenticated',
			credential: {
				type: 'other',
			},
		});
		expect(markdown).toContain('Type:** other authenticated credential');
		expect(markdown).not.toContain('Scoped permissions');
		expect(markdown).not.toContain('OAuth scopes');
	});

	it('preserves an organization principal account type', () => {
		const organization = {
			id: 'principal-org-id',
			type: 'org',
			name: 'principal-org',
			auth: { type: 'alternate_authentication_method' },
		} satisfies HfWhoamiResponse;

		const result = createHfWhoamiOutput(organization, undefined, 'anonymous guidance');

		expect(result).toMatchObject({
			status: 'authenticated',
			account: {
				id: 'principal-org-id',
				type: 'org',
				name: 'principal-org',
				url: 'https://huggingface.co/principal-org',
			},
			organizations: [],
			credential: {
				type: 'other',
			},
		});
	});

	it('returns anonymous guidance in the flat shape without OAuth metadata', () => {
		const result = createHfWhoamiOutput(undefined, undefined, 'Configure authentication.');
		const markdown = formatHfWhoamiMarkdown(result);

		expect(result).toEqual({
			status: 'anonymous',
			account: null,
			organizations: [],
			credential: null,
			guidance: 'Configure authentication.',
		});
		expect(markdown).toContain('used anonymously');
		expect(markdown).toContain('Configure authentication.');
		expect(markdown).not.toContain('OAuth scopes');
	});

	it('reports a supplied but unverifiable credential separately from anonymous access', () => {
		const result = createHfWhoamiOutput(undefined, oauthToken(['read-mcp']), 'Configure authentication.');
		const markdown = formatHfWhoamiMarkdown(result);

		expect(result).toEqual({
			status: 'authentication_unverified',
			account: null,
			organizations: [],
			credential: null,
			guidance: 'A Hugging Face credential was supplied, but its status could not be verified. Retry shortly.',
		});
		expect(markdown).toContain('authentication status could not be verified');
		expect(markdown).not.toContain('OAuth scopes');
	});

	it('enforces strict objects and authentication-state guidance invariants', () => {
		const authenticated = createHfWhoamiOutput(
			baseUser({ type: 'alternate_authentication_method' }),
			undefined,
			'anonymous guidance'
		);
		const anonymous = createHfWhoamiOutput(undefined, undefined, 'Configure authentication.');
		const unverified = createHfWhoamiOutput(undefined, 'hf_unknown-token', 'Configure authentication.');

		expect(hfWhoamiOutputSchema.safeParse({ ...anonymous, guidance: undefined }).success).toBe(false);
		expect(hfWhoamiOutputSchema.safeParse({ ...anonymous, guidance: '' }).success).toBe(false);
		expect(hfWhoamiOutputSchema.safeParse({ ...anonymous, account: authenticated.account }).success).toBe(false);
		expect(hfWhoamiOutputSchema.safeParse({ ...anonymous, credential: authenticated.credential }).success).toBe(false);
		expect(hfWhoamiOutputSchema.safeParse({ ...anonymous, unexpected: true }).success).toBe(false);
		expect(hfWhoamiOutputSchema.safeParse({ ...unverified, guidance: undefined }).success).toBe(false);
		expect(hfWhoamiOutputSchema.safeParse({ ...unverified, account: authenticated.account }).success).toBe(false);
		expect(hfWhoamiOutputSchema.safeParse({ ...authenticated, guidance: 'not allowed' }).success).toBe(false);
		expect(hfWhoamiOutputSchema.safeParse({ ...authenticated, account: null }).success).toBe(false);
		expect(hfWhoamiOutputSchema.safeParse({ ...authenticated, credential: null }).success).toBe(false);
		expect(
			hfWhoamiOutputSchema.safeParse({
				...authenticated,
				account: { ...authenticated.account, unexpected: true },
			}).success
		).toBe(false);
	});
});
