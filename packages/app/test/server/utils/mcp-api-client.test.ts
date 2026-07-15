import { afterEach, describe, expect, it, vi } from 'vitest';
import { DOC_FETCH_TOOL_ID, DOCS_SEMANTIC_SEARCH_TOOL_ID, HF_FS_TOOL_ID } from '@llmindset/hf-mcp';
import { McpApiClient, type ApiClientConfig } from '../../../src/server/utils/mcp-api-client.js';
import { ANONYMOUS_BUILTIN_TOOL_IDS } from '../../../src/server/utils/tool-selection-strategy.js';
import type { TransportInfo } from '../../../src/shared/transport-info.js';

const transportInfo: TransportInfo = {
	transport: 'streamableHttpJson',
	port: 3000,
	defaultHfTokenSet: false,
	jsonResponseEnabled: true,
	externalApiMode: true,
	stdioClient: null,
};

describe('McpApiClient fallback settings', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('exposes hf_fs without default proxied Space tools for anonymous external settings requests', async () => {
		const config: ApiClientConfig = {
			type: 'external',
			externalUrl: 'https://api.example.com/settings',
		};
		const client = new McpApiClient(config, transportInfo);

		const settings = await client.getSettings();

		expect(settings.builtInTools).toEqual([...ANONYMOUS_BUILTIN_TOOL_IDS]);
		expect(settings.builtInTools).toContain(HF_FS_TOOL_ID);
		expect(settings.builtInTools).not.toContain(DOCS_SEMANTIC_SEARCH_TOOL_ID);
		expect(settings.builtInTools).not.toContain(DOC_FETCH_TOOL_ID);
		expect(settings.spaceTools).toEqual([]);
		expect(client.getGradioEndpoints()).toEqual([]);

		const states = await client.getToolStates();
		expect(states?.[HF_FS_TOOL_ID]).toBe(true);
		expect(states?.[DOCS_SEMANTIC_SEARCH_TOOL_ID]).toBe(false);
		expect(states?.[DOC_FETCH_TOOL_ID]).toBe(false);
		expect(client.getGradioEndpoints()).toEqual([]);
	});

	it('removes legacy docs enablement returned by the settings API', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn<typeof fetch>().mockResolvedValue(
				Response.json({
					builtInTools: [HF_FS_TOOL_ID, DOCS_SEMANTIC_SEARCH_TOOL_ID, DOC_FETCH_TOOL_ID],
					spaceTools: [],
				})
			)
		);
		const client = new McpApiClient(
			{
				type: 'external',
				externalUrl: 'http://localhost:3000/settings',
				hfToken: 'token',
			},
			transportInfo
		);

		const settings = await client.getSettings();

		expect(settings.builtInTools).toEqual([HF_FS_TOOL_ID]);
	});
});
