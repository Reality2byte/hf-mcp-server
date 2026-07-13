import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
	DISABLE_TOOLS_ENV,
	disabledToolCallName,
	disabledToolMessage,
	disableConfiguredTool,
	parseDisabledTools,
} from '../../../src/server/utils/disabled-tools.js';

const original = process.env[DISABLE_TOOLS_ENV];

afterEach(() => {
	if (original === undefined) delete process.env[DISABLE_TOOLS_ENV];
	else process.env[DISABLE_TOOLS_ENV] = original;
});

describe('disabled tools', () => {
	it('parses a comma-delimited list and ignores whitespace and empty names', () => {
		expect([...parseDisabledTools(' model_search, dataset_search ,,paper_search ')]).toEqual([
			'model_search',
			'dataset_search',
			'paper_search',
		]);
	});

	it('reads DISABLE_TOOLS by default', () => {
		process.env[DISABLE_TOOLS_ENV] = 'space_search';
		expect(parseDisabledTools()).toEqual(new Set(['space_search']));
	});

	it('recognizes only disabled tools/call requests', () => {
		const disabled = new Set(['model_search']);
		expect(
			disabledToolCallName({ method: 'tools/call', params: { name: 'model_search' } }, disabled)
		).toBe('model_search');
		expect(disabledToolCallName({ method: 'tools/call', params: { name: 'hf_fs' } }, disabled)).toBeUndefined();
		expect(disabledToolCallName({ method: 'tools/list' }, disabled)).toBeUndefined();
	});

	it('disables matching registered tools and leaves others unchanged', () => {
		let calls = 0;
		const tool = { disable: () => calls++ };
		disableConfiguredTool('model_search', tool, new Set(['model_search']));
		disableConfiguredTool('hf_fs', tool, new Set(['model_search']));
		expect(calls).toBe(1);
	});

	it('hides disabled tools from tools/list and rejects stale calls', async () => {
		const server = new McpServer({ name: 'test-server', version: '1.0.0' });
		const tool = server.registerTool('model_search', { inputSchema: {} }, () => ({
			content: [{ type: 'text', text: 'should not run' }],
		}));
		disableConfiguredTool('model_search', tool, new Set(['model_search']));

		const client = new Client({ name: 'test-client', version: '1.0.0' });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

		try {
			expect(await client.listTools()).toEqual({ tools: [] });
			expect(await client.callTool({ name: 'model_search', arguments: {} })).toMatchObject({
				isError: true,
				content: [{ type: 'text', text: expect.stringContaining('Tool model_search disabled') }],
			});
		} finally {
			await client.close();
			await server.close();
		}
	});

	it('returns a stable call error message', () => {
		expect(disabledToolMessage('model_search')).toBe('Tool model_search is disabled by server configuration');
	});
});
