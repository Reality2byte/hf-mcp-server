import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const METRICS_PAGE_AUTH_COOKIE_NAME = 'hf_mcp_metrics_auth';
export const METRICS_PAGE_AUTH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const TOKEN_VERSION = 'v1';
const TOKEN_NONCE_BYTES = 16;
const TOKEN_SIGNATURE_BYTES = 32;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

interface MetricsPageAuthRequest {
	cookieHeader: string | undefined;
	headerPassword: string | undefined;
	queryPassword: unknown;
}

export interface MetricsPageAuth {
	readonly enabled: boolean;
	isPasswordValid(candidate: unknown): boolean;
	isSessionCookieValid(cookieHeader: string | undefined, now?: number): boolean;
	isRequestAuthenticated(request: MetricsPageAuthRequest, now?: number): boolean;
	createSessionToken(now?: number): string | undefined;
}

class MetricsPageAuthImpl implements MetricsPageAuth {
	public readonly enabled: boolean;
	private readonly passwordDigest: Buffer | undefined;

	constructor(password: string | undefined) {
		this.passwordDigest = password !== undefined && password.length > 0 ? digest(password) : undefined;
		this.enabled = this.passwordDigest !== undefined;
	}

	public isPasswordValid(candidate: unknown): boolean {
		if (!this.passwordDigest || typeof candidate !== 'string') {
			return false;
		}

		return timingSafeEqual(digest(candidate), this.passwordDigest);
	}

	public isSessionCookieValid(cookieHeader: string | undefined, now = Date.now()): boolean {
		const token = readCookie(cookieHeader, METRICS_PAGE_AUTH_COOKIE_NAME);
		if (!token || !this.passwordDigest) {
			return false;
		}

		const parts = token.split('.');
		if (parts.length !== 4) {
			return false;
		}

		const [version, expiresAtText, nonce, signatureText] = parts;
		if (
			version !== TOKEN_VERSION ||
			!expiresAtText ||
			!/^\d+$/.test(expiresAtText) ||
			!nonce ||
			!BASE64URL_PATTERN.test(nonce) ||
			!signatureText ||
			!BASE64URL_PATTERN.test(signatureText)
		) {
			return false;
		}

		const signature = Buffer.from(signatureText, 'base64url');
		if (signature.length !== TOKEN_SIGNATURE_BYTES) {
			return false;
		}

		const payload = `${version}.${expiresAtText}.${nonce}`;
		const expectedSignature = sign(payload, this.passwordDigest);
		if (!timingSafeEqual(signature, expectedSignature)) {
			return false;
		}

		const expiresAt = Number(expiresAtText);
		return Number.isSafeInteger(expiresAt) && now < expiresAt;
	}

	public isRequestAuthenticated(request: MetricsPageAuthRequest, now = Date.now()): boolean {
		return (
			this.isSessionCookieValid(request.cookieHeader, now) ||
			this.isPasswordValid(request.headerPassword) ||
			this.isPasswordValid(request.queryPassword)
		);
	}

	public createSessionToken(now = Date.now()): string | undefined {
		if (!this.passwordDigest) {
			return undefined;
		}

		const expiresAt = now + METRICS_PAGE_AUTH_TTL_MS;
		const nonce = randomBytes(TOKEN_NONCE_BYTES).toString('base64url');
		const payload = `${TOKEN_VERSION}.${String(expiresAt)}.${nonce}`;
		const signature = sign(payload, this.passwordDigest).toString('base64url');
		return `${payload}.${signature}`;
	}
}

export function createMetricsPageAuth(password: string | undefined): MetricsPageAuth {
	return new MetricsPageAuthImpl(password);
}

function digest(value: string): Buffer {
	return createHash('sha256').update(value).digest();
}

function sign(payload: string, passwordDigest: Buffer): Buffer {
	return createHmac('sha256', passwordDigest).update(payload).digest();
}

function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
	if (!cookieHeader) {
		return undefined;
	}

	for (const part of cookieHeader.split(';')) {
		const separatorIndex = part.indexOf('=');
		if (separatorIndex === -1) {
			continue;
		}

		const cookieName = part.slice(0, separatorIndex).trim();
		if (cookieName === name) {
			return part.slice(separatorIndex + 1).trim();
		}
	}

	return undefined;
}
