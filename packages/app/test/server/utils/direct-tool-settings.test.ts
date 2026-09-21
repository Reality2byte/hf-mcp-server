import { describe, expect, it } from 'vitest';
import {
	ALL_BUILTIN_TOOL_IDS,
	DYNAMIC_SPACE_TOOL_ID,
	HF_FILES_FLAG,
	HF_FS_WRITE_TOOL_ID,
	TOOL_ID_GROUPS,
} from '@llmindset/hf-mcp';
import {
	getDirectToolCallSettings,
	isConfiguredProxyToolName,
	withoutDiscoverySelectionHeaders,
} from '../../../src/server/utils/direct-tool-settings.js';
import type { ProxyToolDefinition } from '../../../src/server/utils/proxy-tools-config.js';

function call(name: string, args: Record<string, unknown> = {}): unknown {
	return {
		method: 'tools/call',
		params: { name, arguments: args },
	};
}

const proxyTools: ProxyToolDefinition[] = [
	{
		proxyId: 'proxy-group',
		toolName: 'proxy_upload',
		upstreamToolName: 'upload',
		url: 'https://proxy.example/mcp',
	},
	{
		proxyId: 'gradio-shaped-proxy',
		toolName: 'gr1_import',
		upstreamToolName: 'import',
		url: 'https://proxy.example/mcp',
	},
];

describe('getDirectToolCallSettings', () => {
	it.each([...ALL_BUILTIN_TOOL_IDS, ...TOOL_ID_GROUPS.sandbox])(
		'selects the directly requested local tool %s without discovery settings',
		(name) => {
			expect(getDirectToolCallSettings(call(name), {}, proxyTools)).toEqual({
				builtInTools: [name],
				spaceTools: [],
			});
		}
	);

	it('selects fixed and feature-flagged tools using their registration contracts', () => {
		expect(getDirectToolCallSettings(call('hf_whoami'), {}, proxyTools)).toEqual({
			builtInTools: [],
			spaceTools: [],
		});
		expect(getDirectToolCallSettings(call(HF_FS_WRITE_TOOL_ID), {}, proxyTools)).toEqual({
			builtInTools: [HF_FILES_FLAG],
			spaceTools: [],
		});
	});

	it('selects exact startup proxy names before generated Gradio aliases', () => {
		expect(isConfiguredProxyToolName('gr1_import', proxyTools)).toBe(true);
		expect(getDirectToolCallSettings(call('proxy_upload'), {}, proxyTools)).toEqual({
			builtInTools: ['proxy_upload'],
			spaceTools: [],
		});
		expect(getDirectToolCallSettings(call('gr1_import'), {}, proxyTools)).toEqual({
			builtInTools: ['gr1_import'],
			spaceTools: [],
		});
	});

	it('retains settings resolution for generated Gradio aliases', () => {
		expect(getDirectToolCallSettings(call('gr1_predict'), {}, proxyTools)).toBeUndefined();
		expect(getDirectToolCallSettings(call('grp2_private'), {}, proxyTools)).toBeUndefined();
	});

	it('retains image preferences for dynamic Space invocation unless the request explicitly strips images', () => {
		expect(
			getDirectToolCallSettings(call(DYNAMIC_SPACE_TOOL_ID, { operation: 'invoke' }), {}, proxyTools)
		).toBeUndefined();
		expect(
			getDirectToolCallSettings(
				call(DYNAMIC_SPACE_TOOL_ID, { operation: 'invoke' }),
				{ 'x-mcp-no-image-content': 'true' },
				proxyTools
			)
		).toEqual({
			builtInTools: [DYNAMIC_SPACE_TOOL_ID],
			spaceTools: [],
		});
	});

	it('avoids discovery settings for definitely unknown calls', () => {
		expect(getDirectToolCallSettings(call('missing_tool'), {}, proxyTools)).toEqual({
			builtInTools: [],
			spaceTools: [],
		});
		expect(getDirectToolCallSettings({ method: 'tools/call', params: {} }, {}, proxyTools)).toEqual({
			builtInTools: [],
			spaceTools: [],
		});
		expect(getDirectToolCallSettings({ method: 'tools/call', params: { name: 42 } }, {}, proxyTools)).toEqual({
			builtInTools: [],
			spaceTools: [],
		});
	});

	it('does not affect non-call requests', () => {
		expect(getDirectToolCallSettings({ method: 'tools/list' }, {}, proxyTools)).toBeUndefined();
		expect(getDirectToolCallSettings({ method: 'initialize' }, {}, proxyTools)).toBeUndefined();
	});

	it('removes discovery-only selection headers without mutating execution headers', () => {
		const headers = {
			authorization: 'Bearer token',
			'x-mcp-bouquet': 'search',
			'x-mcp-mix': 'jobs',
			'x-mcp-gradio': 'owner/space',
			'x-mcp-no-image-content': 'true',
		};

		expect(withoutDiscoverySelectionHeaders(headers)).toEqual({
			authorization: 'Bearer token',
			'x-mcp-gradio': 'owner/space',
			'x-mcp-no-image-content': 'true',
		});
		expect(headers).toHaveProperty('x-mcp-bouquet', 'search');
	});
});
