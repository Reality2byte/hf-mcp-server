import { createHash } from 'node:crypto';

export interface ProxyAppResourceMapping {
	localUri: string;
	upstreamUri: string;
	proxyId: string;
	upstreamToolName: string;
}

type UnknownRecord = Record<string, unknown>;
const FASTMCP_HASH_LENGTH = 12;

export function rewriteProxyAppToolMeta(
	meta: UnknownRecord | undefined,
	proxyId: string,
	upstreamToolName: string
): { meta?: UnknownRecord; resourceMapping?: ProxyAppResourceMapping } {
	if (!meta) {
		return {};
	}

	const ui = meta.ui;
	if (!isRecord(ui) || typeof ui.resourceUri !== 'string' || !ui.resourceUri.startsWith('ui://')) {
		return { meta };
	}

	const localUri = createProxyAppResourceUri(proxyId, ui.resourceUri);
	const rewrittenMeta = {
		...meta,
		ui: {
			...ui,
			resourceUri: localUri,
		},
	};

	return {
		meta: rewrittenMeta,
		resourceMapping: {
			localUri,
			upstreamUri: ui.resourceUri,
			proxyId,
			upstreamToolName,
		},
	};
}

export function createProxyAppResourceUri(proxyId: string, upstreamUri: string): string {
	const safeProxyId = proxyId.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'proxy';
	const encodedUri = Buffer.from(upstreamUri, 'utf8').toString('base64url');
	return `ui://hf-mcp-proxy/${safeProxyId}/${encodedUri}`;
}

export interface ProxyAppToolCall {
	toolName: string;
	argumentKeys: string[];
}

export function discoverProxyAppToolCalls(value: unknown, appName: string | undefined): ProxyAppToolCall[] {
	if (!appName) {
		return [];
	}

	const found = new Map<string, Set<string>>();
	visitForToolCalls(value, appName, found);

	return Array.from(found.entries()).map(([toolName, argumentKeys]) => ({
		toolName,
		argumentKeys: Array.from(argumentKeys),
	}));
}

export function isFastMcpAppBackendTool(toolName: string, appName: string): boolean {
	const parsed = parseFastMcpBackendToolName(toolName);
	if (!parsed) {
		return false;
	}
	return parsed.digest === hashFastMcpTool(appName, parsed.localName);
}

function visitForToolCalls(value: unknown, appName: string, found: Map<string, Set<string>>): void {
	if (Array.isArray(value)) {
		value.forEach((item) => {
			visitForToolCalls(item, appName, found);
		});
		return;
	}

	if (!isRecord(value)) {
		return;
	}

	if (value.action === 'toolCall' && typeof value.tool === 'string' && isFastMcpAppBackendTool(value.tool, appName)) {
		const argumentKeys = isRecord(value.arguments) ? Object.keys(value.arguments) : [];
		const current = found.get(value.tool) ?? new Set<string>();
		argumentKeys.forEach((key) => current.add(key));
		found.set(value.tool, current);
	}

	Object.values(value).forEach((child) => {
		visitForToolCalls(child, appName, found);
	});
}

function parseFastMcpBackendToolName(toolName: string): { digest: string; localName: string } | null {
	if (toolName.length <= FASTMCP_HASH_LENGTH + 1 || toolName[FASTMCP_HASH_LENGTH] !== '_') {
		return null;
	}

	const digest = toolName.slice(0, FASTMCP_HASH_LENGTH);
	if (!/^[0-9a-f]+$/.test(digest)) {
		return null;
	}

	return {
		digest,
		localName: toolName.slice(FASTMCP_HASH_LENGTH + 1),
	};
}

function hashFastMcpTool(appName: string, toolName: string): string {
	return createHash('sha256').update(`${appName}\0${toolName}`).digest('hex').slice(0, FASTMCP_HASH_LENGTH);
}

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
