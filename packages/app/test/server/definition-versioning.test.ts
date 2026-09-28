import { describe, it, expect, vi } from 'vitest';
import { McpServer, type Tool, type ServerContext, type HandlerResultTypeMap } from '@modelcontextprotocol/server';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import {
	definitionVersions,
	installDefinitionVersioning,
	DEFINITION_VERSIONS,
	KNOWN_DEFINITION_VERSIONS,
	DEFINITION_VERSION_MISMATCH,
	definitionVersioningStats,
	resetDefinitionVersioningStats,
} from '../../src/server/definition-versioning/index.js';

const tool: Tool = {
	name: 'a',
	inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
	_meta: { semantic: true },
};

describe('definition digests', () => {
	it('rejects duplicate names, even with identical definitions', () => {
		for (const duplicate of [tool, { ...tool, description: 'different' }]) {
			expect(() => definitionVersions([tool, { ...tool, name: 'b' }, duplicate])).toThrow('Duplicate tool name: a');
		}
	});
	it('canonicalizes keys and collection order, not semantic array order', () => {
		const other = { ...tool, name: 'b' };
		expect(definitionVersions([tool, other])).toEqual(
			definitionVersions([other, { _meta: { semantic: true }, inputSchema: tool.inputSchema, name: 'a' }])
		);
	});
	it('preserves semantic array ordering', () => {
		const first = { ...tool, inputSchema: { type: 'object' as const, required: ['x', 'y'] } };
		const second = { ...tool, inputSchema: { type: 'object' as const, required: ['y', 'x'] } };
		expect(definitionVersions([first]).tools).not.toBe(definitionVersions([second]).tools);
	});
	it('includes schemas and semantic metadata; separates instructions and absent/empty', () => {
		const base = definitionVersions([tool], 'exact\n');
		for (const changed of [
			{ ...tool, outputSchema: { type: 'object' as const } },
			{ ...tool, _meta: { semantic: false } },
			{ ...tool, description: 'new' },
			{ ...tool, inputSchema: { type: 'object' as const } },
		]) {
			expect(definitionVersions([changed], 'exact\n').tools).not.toBe(base.tools);
		}
		expect(definitionVersions([tool], 'exact').instructions).not.toBe(base.instructions);
		expect(definitionVersions([tool], 'different').tools).toBe(base.tools);
		expect(definitionVersions([]).instructions).not.toBe(definitionVersions([], '').instructions);
		expect(definitionVersions([], '').tools).not.toBe(definitionVersions([], '').instructions);
	});
});

// InMemoryTransport negotiates the legacy era; invoke the decorated discovery
// handler directly here. Modern wire behavior is covered by the HTTP tests.
function discoveryReader(server: McpServer) {
	const register = vi.spyOn(server.server, 'setRequestHandler');
	return async () => {
		const registration = register.mock.calls.findLast(([method]) => method === 'server/discover');
		if (!registration) throw new Error('Missing discovery handler');
		const handler = registration[1] as (
			request: { method: 'server/discover' },
			ctx: ServerContext
		) => HandlerResultTypeMap['server/discover'] | Promise<HandlerResultTypeMap['server/discover']>;
		return handler({ method: 'server/discover' }, {} as ServerContext);
	};
}

async function fixture() {
	const server = new McpServer(
		{ name: 'version-test', version: '1' },
		{ instructions: 'exact', capabilities: { experimental: { existing: { enabled: true } } } }
	);
	const discover = discoveryReader(server);
	installDefinitionVersioning(server, 'exact');
	const validate = vi.fn(() => true);
	const callback = vi.fn(() => ({ content: [{ type: 'text' as const, text: 'done' }] }));
	const registered = server.registerTool('a', { inputSchema: z.object({ x: z.string().refine(validate) }) }, callback);
	const client = new Client({ name: 'test', version: '1' });
	const [c, s] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(s), client.connect(c)]);
	return {
		server,
		discover,
		client,
		callback,
		validate,
		registered,
		close: async () => {
			await client.close();
			await server.close();
		},
	};
}

describe('pre-dispatch guard', () => {
	it('guards an empty registry when all registration is skipped', async () => {
		const server = new McpServer({ name: 'empty', version: '1' });
		const finalize = installDefinitionVersioning(server);
		finalize();
		const client = new Client({ name: 'test', version: '1' });
		const [c, s] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(s), client.connect(c)]);
		try {
			expect((await client.listTools())._meta?.[DEFINITION_VERSIONS]).toEqual({ tools: definitionVersions([]).tools });
			await expect(
				client.callTool({
					name: 'unknown',
					_meta: { [KNOWN_DEFINITION_VERSIONS]: { tools: `sha256:${'0'.repeat(64)}` } },
				})
			).rejects.toMatchObject({ code: DEFINITION_VERSION_MISMATCH });
			await expect(
				client.callTool({ name: 'unknown', _meta: { [KNOWN_DEFINITION_VERSIONS]: definitionVersions([]) } })
			).rejects.toMatchObject({ code: -32602 });
		} finally {
			await client.close();
			await server.close();
		}
	});
	it('preserves existing capabilities without advertising versioning and executes matching and opportunistic calls', async () => {
		const f = await fixture();
		try {
			const versions = (await f.client.listTools())._meta?.[DEFINITION_VERSIONS];
			expect(f.client.getServerCapabilities()?.experimental).toEqual({
				existing: { enabled: true },
			});
			for (const meta of [
				undefined,
				{},
				{ [KNOWN_DEFINITION_VERSIONS]: {} },
				{ [KNOWN_DEFINITION_VERSIONS]: versions },
			]) {
				expect(await f.client.callTool({ name: 'a', arguments: { x: 'ok' }, _meta: meta })).toMatchObject({
					content: [{ text: 'done' }],
				});
			}
			expect(f.callback).toHaveBeenCalledTimes(4);
		} finally {
			await f.close();
		}
	});
	it.each([null, { tools: `sha256:${'0'.repeat(64)}` }])('ignores legacy expected metadata %j', async (value) => {
		const f = await fixture();
		try {
			expect(
				await f.client.callTool({
					name: 'a',
					arguments: { x: 'ok' },
					_meta: { 'huggingface.co/expected-definition-versions': value },
				})
			).toMatchObject({ content: [{ text: 'done' }] });
			expect(f.callback).toHaveBeenCalledTimes(1);
		} finally {
			await f.close();
		}
	});
	it('checks either target independently and detects disabled tools', async () => {
		const f = await fixture();
		try {
			const versions = (await f.discover())._meta?.[DEFINITION_VERSIONS] as {
				tools: string;
				instructions: string;
			};
			for (const known of [{ tools: versions.tools }, { instructions: versions.instructions }]) {
				await f.client.callTool({
					name: 'a',
					arguments: { x: 'ok' },
					_meta: { [KNOWN_DEFINITION_VERSIONS]: known },
				});
			}
			await expect(
				f.client.callTool({
					name: 'unknown',
					_meta: { [KNOWN_DEFINITION_VERSIONS]: { instructions: `sha256:${'0'.repeat(64)}` } },
				})
			).rejects.toMatchObject({ code: DEFINITION_VERSION_MISMATCH });
			f.registered.disable();
			await expect(
				f.client.callTool({ name: 'a', _meta: { [KNOWN_DEFINITION_VERSIONS]: { tools: versions.tools } } })
			).rejects.toMatchObject({ code: DEFINITION_VERSION_MISMATCH });
			expect((await f.client.listTools()).tools).toEqual([]);
			expect(f.callback).toHaveBeenCalledTimes(2);
		} finally {
			await f.close();
		}
	});
	it('rejects stale versions before lookup, argument validation, and callback; tracks live registry', async () => {
		const f = await fixture();
		try {
			const versions = (await f.client.listTools())._meta?.[DEFINITION_VERSIONS];
			f.registered.update({ description: 'changed' });
			for (const name of ['a', 'unknown']) {
				const rejection = f.client.callTool({
					name,
					arguments: { x: 'ok' },
					_meta: { [KNOWN_DEFINITION_VERSIONS]: versions },
				});
				// Stale targets are named; replacement versions are not handed out.
				await expect(rejection).rejects.toMatchObject({
					code: DEFINITION_VERSION_MISMATCH,
					data: { stale: ['tools'] },
				});
				await expect(rejection).rejects.not.toHaveProperty('data.current');
			}
			await expect(
				f.client.callTool({ name: 'a', arguments: { x: 42 }, _meta: { [KNOWN_DEFINITION_VERSIONS]: versions } })
			).rejects.toMatchObject({ code: DEFINITION_VERSION_MISMATCH });
			expect(f.validate).not.toHaveBeenCalled();
			expect(f.callback).not.toHaveBeenCalled();
		} finally {
			await f.close();
		}
	});
	it.each([null, [], 'bad', { tools: 1 }, { unknown: `sha256:${'0'.repeat(64)}` }, { prompts: 'p', resources: 'r' }])(
		'ignores hints that make no claim about versioned targets: %j',
		async (value) => {
			const f = await fixture();
			try {
				expect(
					await f.client.callTool({ name: 'a', arguments: { x: 'ok' }, _meta: { [KNOWN_DEFINITION_VERSIONS]: value } })
				).toMatchObject({ content: [{ text: 'done' }] });
				expect(f.callback).toHaveBeenCalledTimes(1);
			} finally {
				await f.close();
			}
		}
	);
	it('checks versioned targets alongside unknown ones, and treats unrecognized strings as stale', async () => {
		const f = await fixture();
		try {
			const { tools } = (await f.client.listTools())._meta?.[DEFINITION_VERSIONS] as { tools: string };
			await f.client.callTool({
				name: 'a',
				arguments: { x: 'ok' },
				_meta: { [KNOWN_DEFINITION_VERSIONS]: { tools, prompts: 'sha256:elsewhere' } },
			});
			for (const stale of ['', 'not-a-digest', tools.toUpperCase()]) {
				await expect(
					f.client.callTool({
						name: 'a',
						arguments: { x: 'ok' },
						_meta: { [KNOWN_DEFINITION_VERSIONS]: { tools: stale } },
					})
				).rejects.toMatchObject({ code: DEFINITION_VERSION_MISMATCH, data: { stale: ['tools'] } });
			}
			expect(f.callback).toHaveBeenCalledTimes(1);
			expect(f.validate).toHaveBeenCalledTimes(1);
		} finally {
			await f.close();
		}
	});
	it('lists once and hashes exactly the returned tools, without instructions', async () => {
		const f = await fixture();
		try {
			const list = vi.fn(() => ({ tools: [{ ...tool, description: String(list.mock.calls.length) }] }));
			f.server.server.setRequestHandler('tools/list', list);
			const result = await f.client.listTools();
			expect(list).toHaveBeenCalledTimes(1);
			expect(result._meta?.[DEFINITION_VERSIONS]).toEqual({ tools: definitionVersions(result.tools).tools });
		} finally {
			await f.close();
		}
	});
	it.each([undefined, '', 'replacement', 'exact'])(
		'advertises an instructions version only for the checked instructions: %j',
		async (instructions) => {
			const f = await fixture();
			try {
				f.server.server.setRequestHandler('server/discover', () => ({
					supportedVersions: ['2026-07-28'],
					capabilities: f.server.server.getCapabilities(),
					...(instructions !== undefined ? { instructions } : {}),
					_meta: { existing: 'yes' },
				}));
				const result = await f.discover();
				expect(result.instructions).toBe(instructions);
				const current = definitionVersions((await f.client.listTools()).tools, 'exact');
				expect(result._meta).toEqual({
					existing: 'yes',
					[DEFINITION_VERSIONS]: instructions === 'exact' ? current : { tools: current.tools },
				});
			} finally {
				await f.close();
			}
		}
	);
	it.each([undefined, ''])('preserves configured discovery instructions presence: %j', async (instructions) => {
		const server = new McpServer({ name: 'empty', version: '1' }, { instructions });
		const discover = discoveryReader(server);
		installDefinitionVersioning(server, instructions)();
		const client = new Client({ name: 'test', version: '1' });
		const [c, s] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(s), client.connect(c)]);
		try {
			const result = await discover();
			expect(Object.hasOwn(result, 'instructions')).toBe(instructions !== undefined);
			expect(result.instructions).toBe(instructions);
			expect(result._meta?.[DEFINITION_VERSIONS]).toEqual(definitionVersions([], instructions));
		} finally {
			await client.close();
			await server.close();
		}
	});
	it('ignores envelope TTL/cursors and preserves list metadata', async () => {
		const f = await fixture();
		try {
			let ttl = 10;
			f.server.server.setRequestHandler('tools/list', () => ({
				tools: [tool],
				nextCursor: String(ttl),
				_meta: { ttl, existing: 'yes' },
			}));
			const first = await f.client.listTools();
			ttl = 20;
			const second = await f.client.listTools();
			expect(second._meta).toMatchObject({
				ttl: 20,
				existing: 'yes',
				[DEFINITION_VERSIONS]: first._meta?.[DEFINITION_VERSIONS],
			});
		} finally {
			await f.close();
		}
	});
});

describe('salted versions', () => {
	it('changes every version without changing definitions; unsalted input is unchanged', () => {
		const unsalted = definitionVersions([tool], 'exact');
		expect(definitionVersions([tool], 'exact', '')).toEqual(unsalted);
		const salted = definitionVersions([tool], 'exact', 's1');
		expect(salted.tools).not.toBe(unsalted.tools);
		expect(salted.instructions).not.toBe(unsalted.instructions);
		expect(definitionVersions([tool], 'exact', 's2').tools).not.toBe(salted.tools);
	});
	it('uses the salt for listing, discovery and checks consistently', async () => {
		const server = new McpServer({ name: 'salted', version: '1' }, { instructions: 'exact' });
		const discover = discoveryReader(server);
		installDefinitionVersioning(server, 'exact', { salt: 's1' });
		const callback = vi.fn(() => ({ content: [{ type: 'text' as const, text: 'done' }] }));
		server.registerTool('a', { inputSchema: z.object({}) }, callback);
		const client = new Client({ name: 'test', version: '1' });
		const [c, s] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(s), client.connect(c)]);
		try {
			const listing = await client.listTools();
			const expected = definitionVersions(listing.tools, 'exact', 's1');
			expect(listing._meta?.[DEFINITION_VERSIONS]).toEqual({ tools: expected.tools });
			expect((await discover())._meta?.[DEFINITION_VERSIONS]).toEqual(expected);
			await client.callTool({ name: 'a', arguments: {}, _meta: { [KNOWN_DEFINITION_VERSIONS]: expected } });
			const unsalted = definitionVersions(listing.tools, 'exact');
			await expect(
				client.callTool({ name: 'a', arguments: {}, _meta: { [KNOWN_DEFINITION_VERSIONS]: unsalted } })
			).rejects.toMatchObject({ code: DEFINITION_VERSION_MISMATCH, data: { stale: ['tools', 'instructions'] } });
			expect(callback).toHaveBeenCalledTimes(1);
		} finally {
			await client.close();
			await server.close();
		}
	});
});

describe('activity counters', () => {
	it('counts versioned lists and checked calls by outcome and stale target', async () => {
		resetDefinitionVersioningStats();
		const f = await fixture();
		try {
			const versions = (await f.discover())._meta?.[DEFINITION_VERSIONS] as { tools: string; instructions: string };
			await f.client.listTools();
			await f.client.callTool({ name: 'a', arguments: { x: 'ok' }, _meta: { [KNOWN_DEFINITION_VERSIONS]: versions } });
			await f.client.callTool({ name: 'a', arguments: { x: 'ok' } });
			await expect(
				f.client.callTool({
					name: 'a',
					arguments: { x: 'ok' },
					_meta: { [KNOWN_DEFINITION_VERSIONS]: { tools: 'stale', instructions: 'stale' } },
				})
			).rejects.toMatchObject({ code: DEFINITION_VERSION_MISMATCH });
			expect(definitionVersioningStats()).toMatchObject({
				versionedDiscoveries: 1,
				checkedCalls: 2,
				matched: 1,
				mismatched: 1,
				staleTools: 1,
				staleInstructions: 1,
				lastCheckedAt: expect.any(String),
				lastMismatchAt: expect.any(String),
			});
			expect(definitionVersioningStats().versionedLists).toBeGreaterThanOrEqual(1);
		} finally {
			await f.close();
		}
	});
});
