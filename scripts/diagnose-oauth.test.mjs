import assert from 'node:assert/strict';
import { connect } from 'node:net';
import test from 'node:test';
import {
	createDiagnosticFetch,
	createMetadataServer,
	DiagnosticOAuthProvider,
	reportConnectionResult,
} from './diagnose-oauth.mjs';

function provider() {
	return new DiagnosticOAuthProvider('http://127.0.0.1:8090/oauth/callback', undefined, () => {}, 'state', 'read-mcp');
}

test('anonymous connection cannot be reported as OAuth success', () => {
	const messages = [];
	assert.equal(
		reportConnectionResult(provider(), 3, (message) => messages.push(message)),
		false
	);
	assert.match(messages[0], /Anonymous.*OAuth was not exercised/);
	assert.doesNotMatch(messages[0], /Authenticated/);
});

test('authenticated result requires an access token', () => {
	const auth = provider();
	auth.saveTokens({ access_token: 'test-token', token_type: 'Bearer' });
	const messages = [];
	assert.equal(
		reportConnectionResult(auth, 3, (message) => messages.push(message)),
		true
	);
	assert.match(messages[0], /Authenticated.*3 tools/);
	assert.doesNotMatch(messages[0], /test-token/);
});

test('discovery state and PKCE verifier survive the callback leg in memory', () => {
	const auth = provider();
	assert.equal(auth.discoveryState(), undefined);
	const state = {
		authorizationServerUrl: 'https://huggingface.co',
		authorizationServerMetadata: { issuer: 'https://huggingface.co' },
	};
	auth.saveDiscoveryState(state);
	auth.saveCodeVerifier('test-verifier');
	assert.deepEqual(auth.discoveryState(), state);
	assert.equal(auth.codeVerifier(), 'test-verifier');
	assert.equal(provider().discoveryState(), undefined);
});

test('scope override reports original metadata and explicitly identifies modified discovery', async (t) => {
	const messages = [];
	t.mock.method(console, 'log', (message) => messages.push(message));
	const metadata = { scopes_supported: ['openid', 'read-mcp'], authorization_servers: ['https://huggingface.co'] };
	const fetcher = createDiagnosticFetch('read-mcp', new URL('https://huggingface.co/mcp'), async () =>
		Response.json(metadata)
	);
	const response = await fetcher('https://huggingface.co/.well-known/oauth-protected-resource/mcp');
	assert.deepEqual(await response.json(), { ...metadata, scopes_supported: ['read-mcp'] });
	assert.match(messages.join('\n'), /Server-advertised scopes: \["openid","read-mcp"\]/);
	assert.match(messages.join('\n'), /not an unmodified discovery test/);
	await assert.rejects(fetcher('https://untrusted.example/oauth/token'), /unexpected origin/);
});

test('non-discovery responses are not rewritten', async () => {
	const original = Response.json({ access_token: 'test-token' });
	const fetcher = createDiagnosticFetch('read-mcp', new URL('https://huggingface.co/mcp'), async () => original);
	assert.equal(await fetcher('https://huggingface.co/oauth/token'), original);
});

test('public metadata handler rejects malformed request targets without crashing', async () => {
	const server = createMetadataServer(() => ({ client_id: 'test' }));
	const origin = await server.listen();
	try {
		const reply = await new Promise((resolve, reject) => {
			const socket = connect(Number(new URL(origin).port), '127.0.0.1');
			let text = '';
			socket.on('error', reject);
			socket.on('connect', () => socket.write('GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'));
			socket.on('data', (chunk) => {
				text += chunk;
			});
			socket.on('end', () => resolve(text));
		});
		assert.match(reply, /HTTP\/1.1 400/);
		assert.equal((await fetch(`${origin}/oauth/client-metadata.json`)).status, 200);
	} finally {
		await server.close();
	}
});
