import { describe, expect, it } from 'vitest';
import { isProxyToolEnabled } from '../../src/server/mcp-proxy.js';

describe('isProxyToolEnabled', () => {
	const config = {
		proxyId: 'hf_bucket_upload',
		toolName: 'upload_file',
		meta: undefined,
	};

	it('registers all proxy tools when no enabled set is provided', () => {
		expect(isProxyToolEnabled(config, null)).toBe(true);
	});

	it('registers a proxy tool when its individual tool name is enabled', () => {
		expect(isProxyToolEnabled(config, new Set(['upload_file']))).toBe(true);
	});

	it('registers a proxy tool when its proxy id group is enabled', () => {
		expect(isProxyToolEnabled(config, new Set(['hf_bucket_upload']))).toBe(true);
	});

	it('skips a proxy tool when neither its tool name nor proxy id is enabled', () => {
		expect(isProxyToolEnabled(config, new Set(['hf_hub_query']))).toBe(false);
	});
});
