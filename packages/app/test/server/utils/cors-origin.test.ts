import { describe, expect, it } from 'vitest';
import { matchesCorsOrigin, normalizeCorsOrigin } from '../../../src/server/utils/cors-origin.js';

describe('CORS origin matching', () => {
	it('normalizes trailing slashes', () => {
		expect(normalizeCorsOrigin('https://app.example.com///')).toBe('https://app.example.com');
	});

	it('matches exact origins', () => {
		expect(matchesCorsOrigin('https://app.example.com/', 'https://app.example.com')).toBe(true);
		expect(matchesCorsOrigin('https://other.example.com', 'https://app.example.com')).toBe(false);
	});

	it('matches wildcard subdomains', () => {
		expect(matchesCorsOrigin('https://app.example.com', 'https://*.example.com/')).toBe(true);
		expect(matchesCorsOrigin('http://nested.app.example.com', '*.example.com')).toBe(true);
	});

	it('enforces wildcard scheme and hostname boundaries', () => {
		expect(matchesCorsOrigin('http://app.example.com', 'https://*.example.com')).toBe(false);
		expect(matchesCorsOrigin('https://example.com', 'https://*.example.com')).toBe(false);
		expect(matchesCorsOrigin('https://evil-example.com', 'https://*.example.com')).toBe(false);
		expect(matchesCorsOrigin('https://app.example.com.attacker.test', 'https://*.example.com')).toBe(false);
	});

	it('rejects unsupported wildcard forms and invalid origins', () => {
		expect(matchesCorsOrigin('https://app.example.com', 'https://app.*.com')).toBe(false);
		expect(matchesCorsOrigin('not an origin', 'https://*.example.com')).toBe(false);
	});
});
