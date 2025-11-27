import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport, type SSEClientTransportOptions } from '@modelcontextprotocol/sdk/client/sse.js';
import { CallToolResultSchema, type ServerNotification, type ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra, RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';

export interface GradioCallResult {
	result: typeof CallToolResultSchema._type;
	capturedHeaders: Record<string, string>;
}

export interface GradioCallOptions {
	/** Called for every response to capture custom headers */
	onHeaders?: (headers: Headers) => void;
	/** Log the X-Proxied-Replica header to stderr once */
	logProxiedReplica?: boolean;
}

/**
 * Shared helper to call a Gradio MCP tool over SSE, capturing response headers (including X-Proxied-Replica).
 * This handles SSE setup, optional progress relay, and cleans up the client connection.
 */
export async function callGradioToolWithHeaders(
	sseUrl: string,
	toolName: string,
	parameters: Record<string, unknown>,
	hfToken: string | undefined,
	extra: RequestHandlerExtra<ServerRequest, ServerNotification> | undefined,
	options: GradioCallOptions = {}
): Promise<GradioCallResult> {
	const capturedHeaders: Record<string, string> = {};
	let loggedHeader = false;

	const handleHeaders = (headers: Headers): void => {
		const proxiedReplica = headers.get('x-proxied-replica') ?? '';
		if (proxiedReplica) {
			capturedHeaders['x-proxied-replica'] = proxiedReplica;
		}
		if (options.logProxiedReplica && !loggedHeader) {
			console.error(`Gradio response header X-Proxied-Replica: ${proxiedReplica || 'none'}`);
			loggedHeader = true;
		}
		options.onHeaders?.(headers);
	};

	const captureHeadersFetch: SSEClientTransportOptions['fetch'] = async (url, init) => {
		const response = await fetch(url, init);
		handleHeaders(response.headers);
		return response;
	};

	type EventSourceFetch = NonNullable<SSEClientTransportOptions['eventSourceInit']>['fetch'];
	const buildEventSourceFetch =
		(extraHeaders?: Record<string, string>): EventSourceFetch =>
		(url, init) => {
			const headers = new Headers(init?.headers);
			if (extraHeaders) {
				Object.entries(extraHeaders).forEach(([key, value]) => headers.set(key, value));
			}
			const requestInit: RequestInit = { ...(init as RequestInit), headers };
			return captureHeadersFetch(url.toString(), requestInit);
		};

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
	const transportOptions: SSEClientTransportOptions = {
		fetch: captureHeadersFetch,
	};
	if (hfToken) {
		const headerName = 'X-HF-Authorization';
		const customHeaders = {
			[headerName]: `Bearer ${hfToken}`,
		};

		// Headers for POST requests
		transportOptions.requestInit = {
			headers: customHeaders,
		};

		// Headers for SSE connection
		transportOptions.eventSourceInit = {
			fetch: buildEventSourceFetch(customHeaders),
		};
	} else {
		transportOptions.eventSourceInit = {
			fetch: buildEventSourceFetch(),
		};
	}

	const transport = new SSEClientTransport(new URL(sseUrl), transportOptions);
	await remoteClient.connect(transport);

	try {
		// Check if the client is requesting progress notifications
		const progressToken = extra?._meta?.progressToken;
		const requestOptions: RequestOptions = {};

		if (progressToken !== undefined && extra) {
			// Fire-and-forget; best-effort relay
			requestOptions.onprogress = (progress) => {
				void extra.sendNotification({
					method: 'notifications/progress',
					params: {
						progressToken,
						progress: progress.progress,
						total: progress.total,
						message: progress.message,
					},
				});
			};
			requestOptions.resetTimeoutOnProgress = true;
		}

		const result = await remoteClient.request(
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

		return { result, capturedHeaders };
	} finally {
		await remoteClient.close();
	}
}
