import { afterEach, describe, expect, it } from 'vitest';
import {
	createProxyAppResourceUri,
	discoverProxyAppToolCalls,
	isFastMcpAppBackendTool,
	rewriteProxyAppToolMeta,
} from '../../../src/server/utils/proxy-apps.js';
import {
	cacheDiscoveredProxyAppTool,
	getProxyToolDefinition,
	getProxyToolsConfig,
	resetProxyToolsConfigForTest,
	type ProxyToolDefinition,
} from '../../../src/server/utils/proxy-tools-config.js';

describe('proxy apps', () => {
	afterEach(() => {
		resetProxyToolsConfigForTest();
	});

	it('rewrites MCP App ui resource URIs and records the upstream mapping', () => {
		const result = rewriteProxyAppToolMeta(
			{
				ui: {
					resourceUri: 'ui://file-upload/app.html',
					csp: {
						connectSrc: ['https://huggingface.co'],
					},
				},
				visibility: ['model', 'app'],
			},
			'hf_bucket_upload',
			'upload_files'
		);

		expect(result.resourceMapping).toEqual({
			localUri: createProxyAppResourceUri('hf_bucket_upload', 'ui://file-upload/app.html'),
			upstreamUri: 'ui://file-upload/app.html',
			proxyId: 'hf_bucket_upload',
			upstreamToolName: 'upload_files',
		});
		expect(result.meta).toEqual({
			ui: {
				resourceUri: createProxyAppResourceUri('hf_bucket_upload', 'ui://file-upload/app.html'),
				csp: {
					connectSrc: ['https://huggingface.co'],
				},
			},
			visibility: ['model', 'app'],
		});
	});

	it('leaves non-app metadata unchanged', () => {
		const meta = { openai: { outputTemplate: 'ui://template' } };
		const result = rewriteProxyAppToolMeta(meta, 'proxy', 'tool');

		expect(result.meta).toBe(meta);
		expect(result.resourceMapping).toBeUndefined();
	});

	it('recognizes FastMCP hashed app backend tool names', () => {
		expect(isFastMcpAppBackendTool('0a9f249006af_store_files', 'Hugging Face Bucket')).toBe(true);
		expect(isFastMcpAppBackendTool('0a9f249006af_store_files', 'Other App')).toBe(false);
		expect(isFastMcpAppBackendTool('store_files', 'Hugging Face Bucket')).toBe(false);
	});

	it('discovers FastMCP app tool calls from structured content', () => {
		const result = discoverProxyAppToolCalls(
			{
				structuredContent: {
					view: {
						type: 'Button',
						onClick: {
							action: 'toolCall',
							tool: '0a9f249006af_store_files',
							arguments: {
								files: '{{ pending }}',
							},
						},
					},
				},
			},
			'Hugging Face Bucket'
		);

		expect(result).toEqual([
			{
				toolName: '0a9f249006af_store_files',
				argumentKeys: ['files'],
			},
		]);
	});

	it('caches discovered app backend tools for later stateless requests', () => {
		resetProxyToolsConfigForTest();
		const parentConfig: ProxyToolDefinition = {
			proxyId: 'hf_bucket_upload',
			toolName: 'upload_files',
			upstreamToolName: 'upload_files',
			url: 'https://example.com/mcp',
			responseType: 'JSON',
		};

		cacheDiscoveredProxyAppTool(parentConfig, '0a9f249006af_store_files', ['files']);
		cacheDiscoveredProxyAppTool(parentConfig, '0a9f249006af_store_files', ['targetRepo']);

		expect(getProxyToolsConfig()).toHaveLength(1);
		expect(getProxyToolDefinition('0a9f249006af_store_files')).toMatchObject({
			proxyId: 'hf_bucket_upload',
			toolName: '0a9f249006af_store_files',
			upstreamToolName: '0a9f249006af_store_files',
			url: 'https://example.com/mcp',
			inputSchema: {
				type: 'object',
				properties: {
					files: {},
					targetRepo: {},
				},
			},
			meta: {
				visibility: ['app'],
				hfProxy: {
					discoveredFrom: 'upload_files',
					upstreamToolName: '0a9f249006af_store_files',
				},
			},
		});
	});
});
