import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { Request, Response } from 'express';
import { SERVER_VERSION } from './server-build-info.js';

export const SERVER_CARD_PATH = '/mcp/server-card';
export const SERVER_CARD_MEDIA_TYPE = 'application/mcp-server-card+json';
const SERVER_CARD_SCHEMA_URL = 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json';
export const MCP_SERVER_NAME = 'huggingface.co/mcp';
const DEFAULT_MCP_REMOTE_URL = 'https://huggingface.co/mcp';

interface ServerCardRemote {
	type: 'streamable-http';
	url: string;
}

export interface ServerCard {
	$schema: string;
	name: string;
	version: string;
	description: string;
	title?: string;
	websiteUrl?: string;
	remotes?: ServerCardRemote[];
}

export function buildServerCard(remoteUrl = DEFAULT_MCP_REMOTE_URL): ServerCard {
	return {
		$schema: SERVER_CARD_SCHEMA_URL,
		name: MCP_SERVER_NAME,
		version: SERVER_VERSION,
		description: 'Official MCP server for the Hugging Face Hub.',
		title: 'Hugging Face',
		websiteUrl: DEFAULT_MCP_REMOTE_URL,
		remotes: [
			{
				type: 'streamable-http',
				url: remoteUrl,
			},
		],
	};
}

interface ServerCardRepresentation {
	body: string;
	etag: string;
}

function createServerCardRepresentation(remoteUrl: string): ServerCardRepresentation {
	const body = JSON.stringify(buildServerCard(remoteUrl));
	return {
		body,
		etag: `"${createHash('sha256').update(body).digest('base64url')}"`,
	};
}

function normalizeEntityTag(tag: string): string {
	return tag.trim().replace(/^W\//u, '');
}

function matchesServerCardEtag(ifNoneMatch: string | string[] | undefined, etag: string): boolean {
	if (ifNoneMatch === undefined) return false;

	const candidates = Array.isArray(ifNoneMatch) ? ifNoneMatch : [ifNoneMatch];
	const normalizedEtag = normalizeEntityTag(etag);
	return candidates.some((candidateList) =>
		candidateList
			.split(',')
			.some((candidate) => candidate.trim() === '*' || normalizeEntityTag(candidate) === normalizedEtag)
	);
}

export function isServerCardRequestUrl(originalUrl: string): boolean {
	const queryStart = originalUrl.indexOf('?');
	const pathname = queryStart === -1 ? originalUrl : originalUrl.slice(0, queryStart);
	return pathname === SERVER_CARD_PATH;
}

function normalizeHostname(hostname: string): string {
	return hostname.trim().toLowerCase().replace(/^\[/u, '').replace(/\]$/u, '').replace(/\.$/u, '');
}

function isLoopbackHostname(hostname: string): boolean {
	const normalized = normalizeHostname(hostname);
	return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function isConfiguredSelfHostedHostname(hostname: string): boolean {
	const normalized = normalizeHostname(hostname);
	if (
		isIP(normalized) !== 0 ||
		normalized === 'huggingface.co' ||
		normalized === 'hf.co' ||
		normalized.endsWith('.hf.space')
	) {
		return false;
	}

	return (process.env.MCP_ALLOWED_HOSTS ?? '')
		.split(',')
		.map(normalizeHostname)
		.some((allowed) => {
			if (allowed.startsWith('*.')) {
				const suffix = allowed.slice(2);
				return normalized.endsWith(`.${suffix}`) && normalized !== suffix;
			}
			return allowed === normalized;
		});
}

function remoteUrlForRequest(req: Request): string {
	if (!isLoopbackHostname(req.hostname) && !isConfiguredSelfHostedHostname(req.hostname)) {
		return DEFAULT_MCP_REMOTE_URL;
	}

	const forwardedHost = req.get('x-forwarded-host')?.split(',')[0]?.trim();
	const host = forwardedHost || req.get('host');
	return host ? `${req.protocol}://${host}/mcp` : DEFAULT_MCP_REMOTE_URL;
}

export function handleServerCardRequest(req: Request, res: Response): void {
	const representation = createServerCardRepresentation(remoteUrlForRequest(req));
	res.setHeader('Content-Type', SERVER_CARD_MEDIA_TYPE);
	res.setHeader('Cache-Control', 'public, max-age=3600');
	res.setHeader('ETag', representation.etag);
	res.vary('X-Forwarded-Host');
	res.vary('X-Forwarded-Proto');

	if (matchesServerCardEtag(req.headers['if-none-match'], representation.etag)) {
		res.status(304).end();
		return;
	}

	res.status(200).send(representation.body);
}
