import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { assertPublicCimdUrl, fetchPublicUrl, isPublicIp } from './diagnose-oauth.mjs';

const publicAddress = { address: '93.184.216.34', family: 4 };
const resolve = async () => [publicAddress];
const url = 'https://client.example/metadata.json';

function transport(replies, inspect = () => {}) {
	let calls = 0;
	const request = (target, options) => {
		inspect(target, options);
		const req = new EventEmitter();
		req.destroy = (error) => {
			if (error) req.emit('error', error);
		};
		req.end = () =>
			queueMicrotask(() => {
				const reply = replies[calls++];
				if (reply.stall) return;
				const incoming = new PassThrough();
				incoming.statusCode = reply.status ?? 200;
				incoming.statusMessage = 'OK';
				incoming.rawHeaders = reply.headers ?? ['Content-Type', 'application/json'];
				req.emit('response', incoming);
				if (!reply.stallBody) incoming.end(reply.body ?? '{}');
			});
		return req;
	};
	return {
		request,
		get calls() {
			return calls;
		},
	};
}

test('IP policy rejects private, transition and special-use addresses including alternate IPv6 spellings', () => {
	for (const address of [
		'127.0.0.1',
		'10.0.0.1',
		'100.64.0.1',
		'169.254.169.254',
		'192.0.0.1',
		'192.88.99.1',
		'198.18.0.1',
		'224.0.0.1',
		'not-an-ip',
		'::',
		'::1',
		'0:0:0:0:0:0:0:1',
		'::ffff:127.0.0.1',
		'::ffff:7f00:1',
		'::ffff:8.8.8.8',
		'64:ff9b::7f00:1',
		'100::1',
		'fc00::1',
		'fe80::1',
		'fec0::1',
		'ff00::1',
		'2001:db8::1',
		'2001:0::1',
		'2001:20::1',
		'2002:7f00:1::',
		'3fff::1',
		'3fff:fff::1',
		'4000::1',
		'2606:4700::1%eth0',
	])
		assert.equal(isPublicIp(address), false, address);
	for (const address of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111', '2001:4860:4860::8888']) {
		assert.equal(isPublicIp(address), true, address);
	}
});

test('URL validation rejects empty/mixed DNS answers and unsafe URL forms', async () => {
	for (const addresses of [[], [publicAddress, { address: '127.0.0.1', family: 4 }]]) {
		await assert.rejects(
			assertPublicCimdUrl(url, async () => addresses),
			/non-public/
		);
	}
	for (const value of [
		'http://client.example/doc',
		'https://client.example/',
		'https://user@client.example/doc',
		'https://client.example/doc#fragment',
		'https://[::1]/doc',
	]) {
		await assert.rejects(assertPublicCimdUrl(value, resolve));
	}
	const literal = await assertPublicCimdUrl('https://[2606:4700::1111]/doc', () =>
		assert.fail('literal must not resolve')
	);
	assert.deepEqual(literal.addresses, [{ address: '2606:4700::1111', family: 6 }]);
});

test('socket lookup uses validated DNS snapshot, preserving hostname and Response interface', async () => {
	let dnsCalls = 0;
	const fake = transport([{ body: '{"ok":true}' }], (target, options) => {
		assert.equal(target.hostname, 'client.example');
		assert.equal(options.agent, false);
		assert.equal(options.headers.Accept, 'application/json');
		options.lookup(target.hostname, {}, (error, address, family) => {
			assert.equal(error, null);
			assert.equal(address, publicAddress.address);
			assert.equal(family, 4);
		});
		options.lookup(target.hostname, { all: true }, (error, addresses) => {
			assert.equal(error, null);
			assert.deepEqual(addresses, [publicAddress]);
		});
	});
	const result = await fetchPublicUrl(url, {
		request: fake.request,
		resolve: async () => (++dnsCalls === 1 ? [publicAddress] : [{ address: '127.0.0.1', family: 4 }]),
	});
	assert.equal(dnsCalls, 1);
	assert.equal(result.finalUrl, url);
	assert.ok(result.response instanceof Response);
	assert.equal(result.response.headers.get('content-type'), 'application/json');
	assert.deepEqual(await result.response.json(), { ok: true });
});

test('redirects resolve and validate again before any subsequent connection', async () => {
	let dnsCalls = 0;
	const fake = transport([{ status: 302, headers: ['Location', '/next'] }]);
	await assert.rejects(
		fetchPublicUrl(url, {
			request: fake.request,
			resolve: async () => (++dnsCalls === 1 ? [publicAddress] : [{ address: '127.0.0.1', family: 4 }]),
		}),
		/non-public/
	);
	assert.equal(fake.calls, 1);
	assert.equal(dnsCalls, 2);
	const success = transport([{ status: 307, headers: ['Location', '/next'] }, {}]);
	assert.equal(
		(await fetchPublicUrl(url, { resolve, request: success.request })).finalUrl,
		'https://client.example/next'
	);
});

test('redirect errors and limit are preserved', async () => {
	const missing = transport([{ status: 301, headers: [] }]);
	await assert.rejects(fetchPublicUrl(url, { resolve, request: missing.request }), /no Location/);
	const loop = transport(Array.from({ length: 6 }, () => ({ status: 308, headers: ['Location', '/next'] })));
	await assert.rejects(fetchPublicUrl(url, { resolve, request: loop.request }), /exceeded 5 redirects/);
	assert.equal(loop.calls, 6);
});

test('body cap applies at the boundary and timeout covers headers and body', async () => {
	const exact = transport([{ body: 'x'.repeat(5120) }]);
	assert.equal((await (await fetchPublicUrl(url, { resolve, request: exact.request })).response.text()).length, 5120);
	const large = transport([{ body: 'x'.repeat(5121) }]);
	await assert.rejects(fetchPublicUrl(url, { resolve, request: large.request }), /exceeds 5120 bytes/);
	for (const reply of [{ stall: true }, { stallBody: true }]) {
		const slow = transport([reply]);
		await assert.rejects(fetchPublicUrl(url, { resolve, request: slow.request, timeoutMs: 10 }), /timed out/);
	}
});
