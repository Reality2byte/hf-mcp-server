import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Request } from 'express';
import { validateInboundRequest } from '../../../src/server/utils/inbound-request-security.js';

function request(headers: Record<string, string | undefined>): Request {
	return { headers } as Request;
}

describe('validateInboundRequest', () => {
	const originalAllowedHosts = process.env.MCP_ALLOWED_HOSTS;
	const originalAllowedOrigins = process.env.CORS_ALLOWED_ORIGINS;

	beforeEach(() => {
		delete process.env.MCP_ALLOWED_HOSTS;
		delete process.env.CORS_ALLOWED_ORIGINS;
	});

	afterEach(() => {
		if (originalAllowedHosts === undefined) {
			delete process.env.MCP_ALLOWED_HOSTS;
		} else {
			process.env.MCP_ALLOWED_HOSTS = originalAllowedHosts;
		}

		if (originalAllowedOrigins === undefined) {
			delete process.env.CORS_ALLOWED_ORIGINS;
		} else {
			process.env.CORS_ALLOWED_ORIGINS = originalAllowedOrigins;
		}
	});

	it('allows loopback Host headers by default', () => {
		expect(validateInboundRequest(request({ host: 'localhost:3000' }))).toEqual({ allowed: true });
		expect(validateInboundRequest(request({ host: '127.0.0.1:3000' }))).toEqual({ allowed: true });
		expect(validateInboundRequest(request({ host: '[::1]:3000' }))).toEqual({ allowed: true });
	});

	it('keeps loopback Host headers allowed when deployment hosts are configured', () => {
		process.env.MCP_ALLOWED_HOSTS = 'mcp.example.com';

		expect(validateInboundRequest(request({ host: 'localhost:3000' }))).toEqual({ allowed: true });
		expect(validateInboundRequest(request({ host: '127.0.0.1:3000' }))).toEqual({ allowed: true });
		expect(validateInboundRequest(request({ host: '[::1]:3000' }))).toEqual({ allowed: true });
		expect(validateInboundRequest(request({ host: 'attacker.example:3000' }))).toEqual({
			allowed: false,
			reason: 'Host attacker.example is not allowed',
		});
	});

	it('rejects attacker Host headers by default', () => {
		expect(validateInboundRequest(request({ host: 'attacker.example:3000' }))).toEqual({
			allowed: false,
			reason: 'Host attacker.example is not allowed',
		});
	});

	it('rejects attacker Origin headers even when Host is local', () => {
		expect(
			validateInboundRequest(
				request({
					host: '127.0.0.1:3000',
					origin: 'http://attacker.example:3000',
				})
			)
		).toEqual({
			allowed: false,
			reason: 'Origin http://attacker.example:3000 is not allowed',
		});
	});

	it('allows configured deployment hosts and origins', () => {
		process.env.MCP_ALLOWED_HOSTS = 'mcp.example.com';
		process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com';

		expect(
			validateInboundRequest(
				request({
					host: 'mcp.example.com',
					origin: 'https://app.example.com',
				})
			)
		).toEqual({ allowed: true });
	});

	it('allows origins matching configured subdomain wildcards', () => {
		process.env.MCP_ALLOWED_HOSTS = 'mcp.example.com';
		process.env.CORS_ALLOWED_ORIGINS = 'https://*.example.com';

		expect(
			validateInboundRequest(
				request({
					host: 'mcp.example.com',
					origin: 'https://app.example.com',
				})
			)
		).toEqual({ allowed: true });
	});

	it('honors wildcard origin scheme and subdomain constraints', () => {
		process.env.MCP_ALLOWED_HOSTS = 'mcp.example.com';
		process.env.CORS_ALLOWED_ORIGINS = 'https://*.example.com';

		expect(
			validateInboundRequest(
				request({
					host: 'mcp.example.com',
					origin: 'http://app.example.com',
				})
			)
		).toEqual({
			allowed: false,
			reason: 'Origin http://app.example.com is not allowed',
		});
		expect(
			validateInboundRequest(
				request({
					host: 'mcp.example.com',
					origin: 'https://example.com',
				})
			)
		).toEqual({
			allowed: false,
			reason: 'Origin https://example.com is not allowed',
		});
	});

	it('allows origins whose host is in MCP_ALLOWED_HOSTS', () => {
		process.env.MCP_ALLOWED_HOSTS = 'mcp.example.com';

		expect(
			validateInboundRequest(
				request({
					host: 'mcp.example.com',
					origin: 'https://mcp.example.com',
				})
			)
		).toEqual({ allowed: true });
	});
});
