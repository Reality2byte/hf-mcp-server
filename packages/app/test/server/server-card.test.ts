import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { WebServer } from '../../src/server/web-server.js';
import { StatelessHttpTransport } from '../../src/server/transport/stateless-http-transport.js';
import type { ServerFactory } from '../../src/server/transport/base-transport.js';
import { SERVER_CARD_MEDIA_TYPE, SERVER_CARD_PATH, buildServerCard } from '../../src/server/server-card.js';
import { SERVER_VERSION } from '../../src/server/server-build-info.js';
import { createMetricsPageAuth } from '../../src/server/utils/metrics-page-auth.js';

function webServerPort(webServer: WebServer): number {
	const server = (webServer as unknown as { server: Server | null }).server;
	const address = server?.address();
	if (!address || typeof address === 'string') {
		throw new Error('Expected WebServer to listen on a TCP port');
	}
	return address.port;
}

describe('MCP Server Card', () => {
	const originalAllowedHosts = process.env.MCP_ALLOWED_HOSTS;
	let webServer: WebServer;
	let transport: StatelessHttpTransport;
	let serverFactory: ReturnType<typeof vi.fn>;
	let baseUrl: string;

	beforeEach(async () => {
		webServer = new WebServer({ metricsPageAuth: createMetricsPageAuth('metrics-page-test-password') });
		webServer.setTransportInfo({
			transport: 'streamableHttpJson',
			defaultHfTokenSet: false,
			externalApiMode: false,
			stdioClient: null,
		});
		serverFactory = vi.fn();
		transport = new StatelessHttpTransport(serverFactory as unknown as ServerFactory, webServer.getApp());
		await transport.initialize();
		await webServer.start(0);
		baseUrl = `http://127.0.0.1:${webServerPort(webServer).toString()}`;
	});

	afterEach(async () => {
		await transport.cleanup();
		await webServer.stop();
		if (originalAllowedHosts === undefined) {
			delete process.env.MCP_ALLOWED_HOSTS;
		} else {
			process.env.MCP_ALLOWED_HOSTS = originalAllowedHosts;
		}
	});

	it('serves the canonical public card without authentication', async () => {
		const response = await fetch(`${baseUrl}${SERVER_CARD_PATH}`, {
			headers: {
				Accept: SERVER_CARD_MEDIA_TYPE,
				Authorization: 'Bearer invalid-token-is-ignored-for-public-metadata',
			},
		});

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe(`${SERVER_CARD_MEDIA_TYPE}; charset=utf-8`);
		expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
		expect(response.headers.get('etag')).toMatch(/^"[A-Za-z0-9_-]+"$/u);
		const card = (await response.json()) as {
			version?: unknown;
			remotes?: Array<{ type?: unknown; url?: unknown; headers?: unknown }>;
			tools?: unknown;
			packages?: unknown;
		};
		expect(card.version).toBe(SERVER_VERSION);
		expect(card.remotes).toEqual([{ type: 'streamable-http', url: `${baseUrl}/mcp` }]);
		expect(card).not.toHaveProperty('tools');
		expect(card).not.toHaveProperty('packages');
		expect(card.remotes?.[0]).not.toHaveProperty('headers');
		expect(serverFactory).not.toHaveBeenCalled();

		const mcpResponse = await fetch(`${baseUrl}/mcp`, { redirect: 'manual' });
		expect(mcpResponse.status).not.toBe(401);
		expect(mcpResponse.status).not.toBe(302);
		expect(mcpResponse.headers.get('location')).not.toBe('/metrics/login');
	});

	it('returns a stable ETag and honors If-None-Match', async () => {
		const first = await fetch(`${baseUrl}${SERVER_CARD_PATH}`);
		const firstBody = await first.text();
		const second = await fetch(`${baseUrl}${SERVER_CARD_PATH}`);
		const secondBody = await second.text();

		expect(firstBody).toBe(secondBody);
		expect(first.headers.get('etag')).toBe(second.headers.get('etag'));
		const etag = first.headers.get('etag');
		expect(etag).not.toBeNull();

		const notModified = await fetch(`${baseUrl}${SERVER_CARD_PATH}`, {
			headers: { 'If-None-Match': `W/${etag ?? ''}` },
		});
		expect(notModified.status).toBe(304);
		expect(notModified.headers.get('etag')).toBe(etag);
		expect(notModified.headers.get('cache-control')).toBe('public, max-age=3600');
		expect(await notModified.text()).toBe('');

		const changed = await fetch(`${baseUrl}${SERVER_CARD_PATH}`, {
			headers: { 'If-None-Match': '"different", W/"also-different"' },
		});
		expect(changed.status).toBe(200);
	});

	it('uses the public Hugging Face endpoint when no local request origin is available', () => {
		expect(buildServerCard().remotes?.[0]?.url).toBe('https://huggingface.co/mcp');
	});

	it('advertises an explicitly allowed self-hosted origin', async () => {
		process.env.MCP_ALLOWED_HOSTS = 'mcp.example.com';

		const response = await fetch(`${baseUrl}${SERVER_CARD_PATH}`, {
			headers: { 'X-Forwarded-Host': 'mcp.example.com' },
		});
		const card = (await response.json()) as { remotes?: Array<{ url?: unknown }> };

		expect(response.status).toBe(200);
		expect(card.remotes?.[0]?.url).toBe('http://mcp.example.com/mcp');
		expect(response.headers.get('vary')).toContain('X-Forwarded-Host');
		expect(response.headers.get('vary')).toContain('X-Forwarded-Proto');
	});

	it('advertises a self-hosted origin allowed by a hostname wildcard', async () => {
		process.env.MCP_ALLOWED_HOSTS = '*.example.com';

		const response = await fetch(`${baseUrl}${SERVER_CARD_PATH}`, {
			headers: { 'X-Forwarded-Host': 'mcp.example.com' },
		});
		const card = (await response.json()) as { remotes?: Array<{ url?: unknown }> };

		expect(response.status).toBe(200);
		expect(card.remotes?.[0]?.url).toBe('http://mcp.example.com/mcp');
	});

	it('allows public browser CORS only for the Server Card route', async () => {
		const origin = 'https://catalog-client.example';
		const response = await fetch(`${baseUrl}${SERVER_CARD_PATH}`, {
			headers: { Origin: origin },
		});
		expect(response.status).toBe(200);
		expect(response.headers.get('access-control-allow-origin')).toBe('*');
		expect(response.headers.get('access-control-expose-headers')).toBe('ETag');

		const preflight = await fetch(`${baseUrl}${SERVER_CARD_PATH}`, {
			method: 'OPTIONS',
			headers: {
				Origin: origin,
				'Access-Control-Request-Method': 'GET',
				'Access-Control-Request-Headers': 'If-None-Match',
			},
		});
		expect(preflight.status).toBe(204);
		expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
		expect(preflight.headers.get('access-control-allow-methods')).toBe('GET');
		expect(preflight.headers.get('access-control-allow-headers')).toBe('Content-Type,If-None-Match');

		const mcpPreflight = await fetch(`${baseUrl}/mcp`, {
			method: 'OPTIONS',
			headers: {
				Origin: origin,
				'Access-Control-Request-Method': 'POST',
			},
		});
		expect(mcpPreflight.status).toBe(403);
		expect(mcpPreflight.headers.get('access-control-allow-origin')).not.toBe('*');
	});
});
