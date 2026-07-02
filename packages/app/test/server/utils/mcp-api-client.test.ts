import { describe, expect, it } from 'vitest';
import { HF_FS_TOOL_ID } from '@llmindset/hf-mcp';
import { McpApiClient, type ApiClientConfig } from '../../../src/server/utils/mcp-api-client.js';
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
	it('exposes hf_fs without default proxied Space tools for anonymous external settings requests', async () => {
		const config: ApiClientConfig = {
			type: 'external',
			externalUrl: 'https://api.example.com/settings',
		};
		const client = new McpApiClient(config, transportInfo);

		const settings = await client.getSettings();

		expect(settings.builtInTools).toContain(HF_FS_TOOL_ID);
		expect(settings.spaceTools).toEqual([]);
		expect(client.getGradioEndpoints()).toEqual([]);

		const states = await client.getToolStates();
		expect(states?.[HF_FS_TOOL_ID]).toBe(true);
		expect(client.getGradioEndpoints()).toEqual([]);
	});
});
