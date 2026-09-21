import { describe, expect, it } from 'vitest';
import {
	createMetricsPageAuth,
	METRICS_PAGE_AUTH_COOKIE_NAME,
	METRICS_PAGE_AUTH_TTL_MS,
} from '../../../src/server/utils/metrics-page-auth.js';

describe('metrics page authentication', () => {
	it('is disabled for an unset or empty password', () => {
		expect(createMetricsPageAuth(undefined).enabled).toBe(false);
		expect(createMetricsPageAuth('').enabled).toBe(false);
	});

	it('compares passwords exactly without trimming', () => {
		const auth = createMetricsPageAuth(' password ');

		expect(auth.enabled).toBe(true);
		expect(auth.isPasswordValid(' password ')).toBe(true);
		expect(auth.isPasswordValid('password')).toBe(false);
		expect(auth.isPasswordValid(undefined)).toBe(false);
	});

	it('accepts cookie, header, and query credentials independently', () => {
		const now = Date.parse('2026-08-11T12:00:00.000Z');
		const auth = createMetricsPageAuth('scrape-secret');
		const token = auth.createSessionToken(now);
		if (!token) {
			throw new Error('Expected an enabled authenticator to create a session token');
		}

		expect(
			auth.isRequestAuthenticated(
				{
					cookieHeader: `${METRICS_PAGE_AUTH_COOKIE_NAME}=${token}`,
					headerPassword: undefined,
					queryPassword: undefined,
				},
				now
			)
		).toBe(true);
		expect(
			auth.isRequestAuthenticated(
				{
					cookieHeader: undefined,
					headerPassword: 'scrape-secret',
					queryPassword: undefined,
				},
				now
			)
		).toBe(true);
		expect(
			auth.isRequestAuthenticated(
				{
					cookieHeader: undefined,
					headerPassword: undefined,
					queryPassword: 'scrape-secret',
				},
				now
			)
		).toBe(true);
		expect(
			auth.isRequestAuthenticated(
				{
					cookieHeader: undefined,
					headerPassword: undefined,
					queryPassword: ['scrape-secret'],
				},
				now
			)
		).toBe(false);
	});

	it('creates opaque cookies that expire after 30 days', () => {
		const now = Date.parse('2026-08-11T12:00:00.000Z');
		const password = 'cookie-secret';
		const auth = createMetricsPageAuth(password);
		const token = auth.createSessionToken(now);
		if (!token) {
			throw new Error('Expected an enabled authenticator to create a session token');
		}
		const cookie = `${METRICS_PAGE_AUTH_COOKIE_NAME}=${token}`;

		expect(token).not.toContain(password);
		expect(auth.isSessionCookieValid(cookie, now)).toBe(true);
		expect(auth.isSessionCookieValid(cookie, now + METRICS_PAGE_AUTH_TTL_MS - 1)).toBe(true);
		expect(auth.isSessionCookieValid(cookie, now + METRICS_PAGE_AUTH_TTL_MS)).toBe(false);
	});

	it('rejects malformed, tampered, and password-rotated cookies', () => {
		const now = Date.parse('2026-08-11T12:00:00.000Z');
		const auth = createMetricsPageAuth('original-secret');
		const token = auth.createSessionToken(now);
		if (!token) {
			throw new Error('Expected an enabled authenticator to create a session token');
		}

		const parts = token.split('.');
		const signature = parts[3];
		if (!signature) {
			throw new Error('Expected a signed session token');
		}
		parts[3] = `${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`;
		const tamperedCookie = `${METRICS_PAGE_AUTH_COOKIE_NAME}=${parts.join('.')}`;

		expect(auth.isSessionCookieValid(tamperedCookie, now)).toBe(false);
		expect(auth.isSessionCookieValid(`${METRICS_PAGE_AUTH_COOKIE_NAME}=invalid`, now)).toBe(false);
		expect(
			createMetricsPageAuth('rotated-secret').isSessionCookieValid(`${METRICS_PAGE_AUTH_COOKIE_NAME}=${token}`, now)
		).toBe(false);
	});
});
