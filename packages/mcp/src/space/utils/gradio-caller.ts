import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport, type SSEClientTransportOptions } from '@modelcontextprotocol/sdk/client/sse.js';
import { CallToolResultSchema, type CallToolResult, type ServerNotification, type ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra, RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';

export interface GradioCallResult {
	result: CallToolResult;
	capturedHeaders: Record<string, string>;
}

export interface GradioCallOptions {
	/** Called for every response to capture custom headers */
	onHeaders?: (headers: Headers) => void;
	/** Log the X-Proxied-Replica header to stderr once */
	logProxiedReplica?: boolean;
	/** Optional hook for when progress relay fails (e.g., client disconnected) */
	onProgressRelayFailure?: () => void;
}

/**
 * Extract the replica ID from the X-Proxied-Replica header.
 * Example: "oyerizs4-dspr4" => "dspr4"
 */
export function extractReplicaId(headerValue: string | undefined): string | null {
	if (!headerValue) return null;
	const parts = headerValue.split('-');
	if (parts.length < 2) return null;
	const replicaId = parts[parts.length - 1];
	if (!replicaId || replicaId.trim() === '') return null;
	return replicaId;
}

/**
 * Rewrites any Gradio API URLs in text content to include the replica path segment.
 * Example: https://mcp-tools-qwen-image-fast.hf.space/gradio_api =>
 *          https://mcp-tools-qwen-image-fast.hf.space/--replicas/<replica_id>/gradio_api
 */
export function rewriteReplicaUrlsInResult(
	result: CallToolResult,
	proxiedReplicaHeader: string | undefined
): CallToolResult {
	if (process.env.NO_REPLICA_REWRITE) return result;
	const replicaId = extractReplicaId(proxiedReplicaHeader);
	if (!replicaId) return result;

	const urlPattern = /https:\/\/([^\s"']+)\/gradio_api(\S*)?/g;

	const rewriteText = (text: string): string =>
		text.replace(urlPattern, (_match, host, rest = '') => {
			return `https://${host}/--replicas/${replicaId}/gradio_api${rest}`;
		});

	let changed = false;
	const newContent = result.content.map((item) => {
		if (typeof item === 'string') {
			const rewritten = rewriteText(item);
			if (rewritten !== item) {
				changed = true;
				return { type: 'text', text: rewritten } as (typeof result.content)[number];
			}
			return { type: 'text', text: item } as (typeof result.content)[number];
		}

		if (item && typeof item === 'object' && 'text' in item && typeof item.text === 'string') {
			const rewritten = rewriteText(item.text);
			if (rewritten !== item.text) {
				changed = true;
				return { ...item, text: rewritten };
			}
		}

		return item;
	});

	if (!changed) return result;
	return {
		...result,
		content: newContent,
	};
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

		// Track whether we've seen a transport closure to avoid noisy retries
		let progressRelayDisabled = false;

		const sendProgressNotification = async (progress: { progress?: number; total?: number; message?: string }) => {
			if (!extra || progressRelayDisabled) return;
			if (extra.signal?.aborted) {
				progressRelayDisabled = true;
				return;
			}
			try {
				const params: {
					progressToken: number;
					progress: number;
					total?: number;
					message?: string;
				} = {
					progressToken: progressToken as number,
					progress: progress.progress ?? 0,
				};
				if (progress.total !== undefined) {
					params.total = progress.total;
				}
				if (progress.message !== undefined) {
					params.message = progress.message;
				}
				await extra.sendNotification({
					method: 'notifications/progress',
					params,
				});
			} catch {
				// The underlying transport has likely closed (e.g., client disconnected); disable further relays.
				progressRelayDisabled = true;
				options.onProgressRelayFailure?.();
			}
		};

		const requestOptions: RequestOptions = {};

		if (progressToken !== undefined && extra) {
			// Fire-and-forget; best-effort relay
			requestOptions.onprogress = (progress) => {
				void sendProgressNotification(progress);
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

		const proxiedReplica = capturedHeaders['x-proxied-replica'];
		const rewritten = rewriteReplicaUrlsInResult(result, proxiedReplica);

		return { result: rewritten, capturedHeaders };
	} finally {
		await remoteClient.close();
	}
}
