import { fetchWithProfile } from '@llmindset/hf-mcp/network';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	fetchHfWhoami,
	HfWhoamiRequestError,
	isHfWhoamiUnauthorizedError,
} from '../../../src/server/utils/hf-whoami-client.js';

vi.mock('@llmindset/hf-mcp/network', () => ({
	fetchWithProfile: vi.fn(),
	NETWORK_FETCH_PROFILES: {
		hfHub: vi.fn(() => ({
			urlPolicy: {},
			timeoutMs: 12_500,
			maxRedirects: 3,
			externalOnly: true,
		})),
	},
}));

const originalHfApiTimeout = process.env.HF_API_TIMEOUT;

function responseResult(body: unknown, status = 200) {
	const response = new Response(typeof body === 'string' ? body : JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
	return {
		response,
		finalUrl: new URL('https://huggingface.co/api/whoami-v2'),
		redirectsFollowed: 0,
	};
}

function userResponse(auth: Record<string, unknown>) {
	return {
		id: 'user-id',
		type: 'user',
		name: 'alice',
		orgs: [],
		auth,
	};
}

describe('fetchHfWhoami', () => {
	beforeEach(() => {
		vi.mocked(fetchWithProfile).mockReset();
		delete process.env.HF_API_TIMEOUT;
	});

	afterEach(() => {
		if (originalHfApiTimeout === undefined) {
			delete process.env.HF_API_TIMEOUT;
		} else {
			process.env.HF_API_TIMEOUT = originalHfApiTimeout;
		}
	});

	it('calls the Hub API directly and accepts its OAuth response shape', async () => {
		const token = 'hf_oauth_header.payload.signature';
		vi.mocked(fetchWithProfile).mockResolvedValue(
			responseResult(
				userResponse({
					type: 'oauth',
					expiresAt: '2027-08-05T00:00:00.000Z',
				})
			)
		);

		const result = await fetchHfWhoami(token);

		expect(result.auth).toMatchObject({
			type: 'oauth',
			expiresAt: '2027-08-05T00:00:00.000Z',
		});
		expect(fetchWithProfile).toHaveBeenCalledWith(
			'https://huggingface.co/api/whoami-v2',
			expect.objectContaining({ externalOnly: true }),
			{
				timeoutMs: 12_500,
				requestInit: {
					method: 'GET',
					headers: {
						Accept: 'application/json',
						Authorization: `Bearer ${token}`,
					},
				},
			}
		);
	});

	it('accepts current fine-grained data when optional global and canReadGatedRepos fields are absent', async () => {
		vi.mocked(fetchWithProfile).mockResolvedValue(
			responseResult(
				userResponse({
					type: 'access_token',
					accessToken: {
						displayName: 'Do not expose',
						role: 'fineGrained',
						createdAt: '2026-08-04T12:00:00.000Z',
						fineGrained: {
							scoped: [
								{
									entity: {
										_id: '0123456789abcdef01234567',
										type: 'resource-group',
									},
									permissions: ['readRepoContent'],
								},
							],
						},
					},
				})
			)
		);

		const result = await fetchHfWhoami('hf_fine_grained');

		expect(result.auth.accessToken?.fineGrained).toMatchObject({
			scoped: [
				{
					entity: {
						_id: '0123456789abcdef01234567',
						type: 'resource-group',
					},
				},
			],
		});
		expect(result.auth.accessToken?.fineGrained).not.toHaveProperty('global');
		expect(result.auth.accessToken?.fineGrained).not.toHaveProperty('canReadGatedRepos');
	});

	it.each([
		{
			name: 'app token',
			payload: {
				id: 'app-id',
				type: 'app',
				name: 'automation-app',
				scope: {
					role: 'contributor',
					entities: [{ type: 'bucket', name: 'org/bucket' }],
				},
				auth: { type: 'app_token' },
			},
		},
		{
			name: 'alternate authentication method',
			payload: userResponse({
				type: 'alternate_authentication_method',
				expiresAt: '2027-08-05T00:00:00.000Z',
				accessToken: {
					displayName: 'Backing token',
					role: 'read',
					createdAt: '2026-08-04T12:00:00.000Z',
				},
			}),
		},
	])('accepts the current $name response', async ({ payload }) => {
		vi.mocked(fetchWithProfile).mockResolvedValue(responseResult(payload));

		await expect(fetchHfWhoami('credential-without-sdk-prefix-validation')).resolves.toMatchObject(payload);
	});

	it('uses a valid configured HF API timeout', async () => {
		process.env.HF_API_TIMEOUT = '2345';
		vi.mocked(fetchWithProfile).mockResolvedValue(
			responseResult(userResponse({ type: 'alternate_authentication_method' }))
		);

		await fetchHfWhoami('credential');

		expect(vi.mocked(fetchWithProfile).mock.calls[0]?.[2]?.timeoutMs).toBe(2345);
	});

	it('returns a typed, token-safe error for HTTP 401', async () => {
		const token = 'credential-must-not-appear';
		vi.mocked(fetchWithProfile).mockResolvedValue(responseResult({ error: 'Unauthorized' }, 401));

		const error = await fetchHfWhoami(token).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(HfWhoamiRequestError);
		expect(error).toMatchObject({ kind: 'http', statusCode: 401 });
		expect(isHfWhoamiUnauthorizedError(error)).toBe(true);
		expect(String(error)).not.toContain(token);
	});

	it.each([
		{ name: 'malformed JSON', body: 'not-json' },
		{ name: 'contract-invalid JSON', body: { type: 'user', id: 'user-id' } },
	])('rejects $name without exposing the response body', async ({ body }) => {
		vi.mocked(fetchWithProfile).mockResolvedValue(responseResult(body));

		const error = await fetchHfWhoami('credential').catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(HfWhoamiRequestError);
		expect(error).toMatchObject({ kind: 'invalid_response', statusCode: undefined });
		expect(String(error)).not.toContain(JSON.stringify(body));
	});
});
