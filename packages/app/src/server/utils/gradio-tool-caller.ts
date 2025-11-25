import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport, type SSEClientTransportOptions } from '@modelcontextprotocol/sdk/client/sse.js';
import {
	CallToolResultSchema,
	type ServerNotification,
	type ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra, RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { logger } from './logger.js';
import { stripImageContentFromResult, extractUrlFromContent } from './gradio-result-processor.js';

/**
 * Options for calling a Gradio tool
 */
export interface GradioToolCallOptions {
	/** Whether to strip image content from the result */
	stripImageContent?: boolean;
	/** Original tool name (for logging) */
	toolName: string;
	/** Outward-facing tool name (for logging) */
	outwardFacingName: string;
	/** Session information for client-specific handling */
	sessionInfo?: {
		clientSessionId?: string;
		isAuthenticated?: boolean;
		clientInfo?: { name: string; version: string };
	};
	/** Gradio widget URI for OpenAI client */
	gradioWidgetUri?: string;
	/** Space name for structured content */
	spaceName?: string;
}

/**
 * Creates SSE connection to a Gradio endpoint
 */
async function createGradioConnection(sseUrl: string, hfToken?: string): Promise<Client> {
	logger.debug({ url: sseUrl }, 'Creating SSE connection to Gradio endpoint');

	// Create MCP client
	const remoteClient = new Client(
		{
			name: 'hf-mcp-gradio-client',
			version: '1.0.0',
		},
		{
			capabilities: {},
		}
	);

	// Create SSE transport with HF token if available
	const transportOptions: SSEClientTransportOptions = {};
	if (hfToken) {
		const headerName = 'X-HF-Authorization';
		const customHeaders = {
			[headerName]: `Bearer ${hfToken}`,
		};
		logger.trace('Creating Gradio connection with authorization header');

		// Headers for POST requests
		transportOptions.requestInit = {
			headers: customHeaders,
		};

		// Headers for SSE connection
		transportOptions.eventSourceInit = {
			fetch: (url, init) => {
				const headers = new Headers(init.headers);
				Object.entries(customHeaders).forEach(([key, value]) => {
					headers.set(key, value);
				});
				return fetch(url.toString(), { ...init, headers });
			},
		};
	}

	const transport = new SSEClientTransport(new URL(sseUrl), transportOptions);

	// Connect the client to the transport
	await remoteClient.connect(transport);
	logger.debug('SSE connection established');

	return remoteClient;
}

/**
 * Unified Gradio tool caller that handles:
 * - SSE connection management
 * - MCP tool invocation
 * - Progress notification relay
 *
 * Returns the raw MCP result without post-processing. Callers should apply
 * image filtering and OpenAI-specific transforms as needed using applyResultPostProcessing.
 *
 * This ensures both proxied gr_* tools and the space tool's invoke operation
 * behave identically.
 */
export async function callGradioTool(
	sseUrl: string,
	toolName: string,
	parameters: Record<string, unknown>,
	hfToken: string | undefined,
	extra: RequestHandlerExtra<ServerRequest, ServerNotification> | undefined
): Promise<typeof CallToolResultSchema._type> {
	logger.info({ tool: toolName, params: parameters }, 'Calling Gradio tool via unified caller');

	const client = await createGradioConnection(sseUrl, hfToken);

	try {
		// Check if the client is requesting progress notifications
		const progressToken = extra?._meta?.progressToken;
		const requestOptions: RequestOptions = {};

		if (progressToken !== undefined && extra) {
			logger.debug({ tool: toolName, progressToken }, 'Progress notifications requested');

			// Set up progress relay from remote tool to our client
			requestOptions.onprogress = async (progress) => {
				logger.trace({ tool: toolName, progressToken, progress }, 'Relaying progress notification');

				// Relay the progress notification to our client
				await extra.sendNotification({
					method: 'notifications/progress',
					params: {
						progressToken,
						progress: progress.progress,
						total: progress.total,
						message: progress.message,
					},
				});
			};

			// Keep long-running tool calls alive while progress is flowing
			requestOptions.resetTimeoutOnProgress = true;
		}

		// Call the remote tool and return raw result
		return await client.request(
			{
				method: 'tools/call',
				params: {
					name: toolName,
					arguments: parameters,
					_meta: progressToken !== undefined ? { progressToken } : undefined,
				},
			},
			CallToolResultSchema,
			requestOptions
		);
	} finally {
		// Always clean up the connection
		await client.close();
	}
}

/**
 * Applies post-processing to a Gradio tool result:
 * - Image content filtering (conditionally)
 * - OpenAI-specific structured content
 *
 * This should be called after any custom transformations (like _mcpui handling)
 * to ensure consistent behavior across all Gradio tools.
 */
export function applyResultPostProcessing(
	result: typeof CallToolResultSchema._type,
	options: GradioToolCallOptions
): typeof CallToolResultSchema._type {
	// Strip image content if requested
	const filteredResult = stripImageContentFromResult(result, {
		enabled: !!options.stripImageContent,
		toolName: options.toolName,
		outwardFacingName: options.outwardFacingName,
	});

	// For OpenAI MCP client, check if result contains a URL and set structuredContent
	if (options.sessionInfo?.clientInfo?.name === 'openai-mcp') {
		const extractedUrl = extractUrlFromContent(filteredResult.content);
		if (extractedUrl) {
			logger.debug({ tool: options.toolName, url: extractedUrl }, 'Setting structuredContent with extracted URL');
			(
				filteredResult as typeof CallToolResultSchema._type & {
					structuredContent?: { url: string; spaceName?: string };
				}
			).structuredContent = {
				url: extractedUrl,
				spaceName: options.spaceName,
			};
		}
	}

	return filteredResult;
}
