export interface ProxyAppResourceMapping {
	localUri: string;
	upstreamUri: string;
	proxyId: string;
	upstreamToolName: string;
}

type UnknownRecord = Record<string, unknown>;

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

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
