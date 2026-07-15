import type { NextFunction, Request, Response } from 'express';
import { CORS_ALLOWED_ORIGINS } from '../../shared/constants.js';
import { logger } from './logger.js';

const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '::1'];

function parseCsv(value: string | undefined): string[] {
	return (value || '')
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function normalizeHost(host: string): string {
	return host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');
}

function parseHostHeader(hostHeader: string | undefined): string | undefined {
	if (!hostHeader) return undefined;

	try {
		return normalizeHost(new URL(`http://${hostHeader}`).hostname);
	} catch {
		return undefined;
	}
}

function parseOrigin(origin: string | undefined): { origin: string; host: string } | undefined {
	if (!origin) return undefined;

	try {
		const parsed = new URL(origin);
		return {
			origin: parsed.origin.replace(/\/+$/, ''),
			host: normalizeHost(parsed.hostname),
		};
	} catch {
		return undefined;
	}
}

function hostMatches(host: string, allowlist: string[]): boolean {
	return allowlist.some((entry) => {
		const allowed = normalizeHost(entry);
		if (allowed === '*') return true;
		if (allowed.startsWith('*.')) {
			const suffix = allowed.slice(2);
			return host.endsWith(`.${suffix}`) && host !== suffix;
		}
		return host === allowed;
	});
}

function getAllowedHosts(): string[] {
	const configured = parseCsv(process.env.MCP_ALLOWED_HOSTS);
	return configured.length > 0 ? configured : DEFAULT_ALLOWED_HOSTS;
}

function getAllowedOrigins(): string[] {
	const configured = parseCsv(process.env.CORS_ALLOWED_ORIGINS);
	return (configured.length > 0 ? configured : CORS_ALLOWED_ORIGINS).map((origin) => origin.replace(/\/+$/, ''));
}

function originMatches(origin: { origin: string; host: string }, allowlist: string[]): boolean {
	return allowlist.some((entry) => {
		if (entry === origin.origin) return true;

		let scheme: string | undefined;
		let hostPattern = entry;
		if (entry.startsWith('http://') || entry.startsWith('https://')) {
			const schemeSeparator = entry.indexOf('://');
			scheme = entry.slice(0, schemeSeparator);
			hostPattern = entry.slice(schemeSeparator + 3);
		}

		if (!hostPattern.startsWith('*.')) return false;
		if (scheme && !origin.origin.startsWith(`${scheme}://`)) return false;

		const suffix = normalizeHost(hostPattern.slice(2));
		return origin.host.endsWith(`.${suffix}`) && origin.host !== suffix;
	});
}

export function validateInboundRequest(req: Request): { allowed: true } | { allowed: false; reason: string } {
	const allowedHosts = getAllowedHosts();
	const host = parseHostHeader(req.headers.host);

	if (!host) {
		return { allowed: false, reason: 'missing or invalid Host header' };
	}

	if (!hostMatches(host, allowedHosts)) {
		return { allowed: false, reason: `Host ${host} is not allowed` };
	}

	const originHeader = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
	const parsedOrigin = parseOrigin(originHeader);
	if (!originHeader) {
		return { allowed: true };
	}

	if (!parsedOrigin) {
		return { allowed: false, reason: 'invalid Origin header' };
	}

	const allowedOrigins = getAllowedOrigins();
	if (allowedOrigins.includes('*')) {
		return { allowed: true };
	}

	if (originMatches(parsedOrigin, allowedOrigins) || hostMatches(parsedOrigin.host, allowedHosts)) {
		return { allowed: true };
	}

	return { allowed: false, reason: `Origin ${parsedOrigin.origin} is not allowed` };
}

export function inboundRequestSecurityMiddleware(req: Request, res: Response, next: NextFunction): void {
	const result = validateInboundRequest(req);
	if (result.allowed) {
		next();
		return;
	}

	logger.warn(
		{
			host: req.headers.host,
			origin: req.headers.origin,
			path: req.path,
			reason: result.reason,
		},
		'Rejected inbound request'
	);
	res.status(403).send('Forbidden');
}
