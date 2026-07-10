import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { version } = require('../../package.json') as { version: string };

const BUILD_SHA_ENV_KEYS = [
	'MCP_SERVER_BUILD_SHA',
	'BUILD_COMMIT',
	'GITHUB_SHA',
	'GIT_COMMIT_SHA',
	'SOURCE_VERSION',
] as const;

export function resolveServerBuildSha(env: NodeJS.ProcessEnv = process.env): string {
	for (const key of BUILD_SHA_ENV_KEYS) {
		const value = env[key]?.trim();
		if (value && value.toLowerCase() !== 'unknown') {
			return value;
		}
	}
	return 'unknown';
}

export const SERVER_VERSION = version;
export const SERVER_BUILD_SHA = resolveServerBuildSha();
