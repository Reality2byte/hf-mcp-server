import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { getGrantedOAuthScopes } from '../../../src/server/utils/oauth-scopes.js';

function oauthToken(payload: Record<string, unknown>): string {
	const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
	const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
	return `hf_oauth_${header}.${body}.signature`;
}

describe('OAuth scope inspection', () => {
	it('reads and deduplicates the granted scopes from an OAuth access token', () => {
		expect(getGrantedOAuthScopes(oauthToken({ scope: ['openid', 'read-mcp', 'openid'] }))).toEqual({
			status: 'available',
			scopes: ['openid', 'read-mcp'],
		});
	});

	it('accepts a space-delimited scope claim', () => {
		expect(getGrantedOAuthScopes(oauthToken({ scope: 'openid profile read-mcp' }))).toEqual({
			status: 'available',
			scopes: ['openid', 'profile', 'read-mcp'],
		});
	});

	it('distinguishes non-OAuth credentials from unreadable OAuth credentials', () => {
		expect(getGrantedOAuthScopes('hf_personal-token')).toEqual({ status: 'not_oauth', scopes: null });
		expect(getGrantedOAuthScopes('hf_oauth_not-a-jwt')).toEqual({ status: 'unavailable', scopes: null });
		expect(getGrantedOAuthScopes('hf_oauth__refresh_abcdefghijklmnopqrstuvwxyz12345678')).toEqual({
			status: 'unavailable',
			scopes: null,
		});
	});
});
