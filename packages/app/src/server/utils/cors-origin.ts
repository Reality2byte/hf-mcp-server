export function normalizeCorsOrigin(origin: string): string {
	return origin.replace(/\/+$/, '');
}

export function matchesCorsOrigin(requestOrigin: string, allowedOrigin: string): boolean {
	const normalizedRequestOrigin = normalizeCorsOrigin(requestOrigin);
	const normalizedAllowedOrigin = normalizeCorsOrigin(allowedOrigin);
	if (!normalizedAllowedOrigin.includes('*')) {
		return normalizedRequestOrigin === normalizedAllowedOrigin;
	}

	let scheme: string | undefined;
	let hostPattern = normalizedAllowedOrigin;
	if (normalizedAllowedOrigin.startsWith('http://') || normalizedAllowedOrigin.startsWith('https://')) {
		const schemeSeparator = normalizedAllowedOrigin.indexOf('://');
		scheme = normalizedAllowedOrigin.slice(0, schemeSeparator);
		hostPattern = normalizedAllowedOrigin.slice(schemeSeparator + 3);
	}

	if (!hostPattern.startsWith('*.')) return false;

	try {
		const parsedOrigin = new URL(requestOrigin);
		if (scheme && parsedOrigin.protocol !== `${scheme}:`) return false;

		const suffix = hostPattern.slice(2).toLowerCase();
		const host = parsedOrigin.hostname.toLowerCase();
		return host.endsWith(`.${suffix}`) && host !== suffix;
	} catch {
		return false;
	}
}
