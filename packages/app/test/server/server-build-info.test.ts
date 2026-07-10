import { describe, expect, it } from 'vitest';
import { resolveServerBuildSha, SERVER_VERSION } from '../../src/server/server-build-info.js';

describe('server build info', () => {
	it('reads the application package version', () => {
		expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
	});

	it('prefers the explicit server build SHA', () => {
		expect(
			resolveServerBuildSha({
				MCP_SERVER_BUILD_SHA: 'server-sha',
				BUILD_COMMIT: 'build-sha',
				GITHUB_SHA: 'github-sha',
			})
		).toBe('server-sha');
	});

	it('supports common build environment fallbacks', () => {
		expect(resolveServerBuildSha({ BUILD_COMMIT: ' build-sha ' })).toBe('build-sha');
		expect(resolveServerBuildSha({ GITHUB_SHA: 'github-sha' })).toBe('github-sha');
		expect(resolveServerBuildSha({ GIT_COMMIT_SHA: 'git-sha' })).toBe('git-sha');
		expect(resolveServerBuildSha({ SOURCE_VERSION: 'source-sha' })).toBe('source-sha');
	});

	it('ignores unknown placeholders when checking fallbacks', () => {
		expect(
			resolveServerBuildSha({
				MCP_SERVER_BUILD_SHA: 'unknown',
				BUILD_COMMIT: 'UNKNOWN',
				GITHUB_SHA: 'github-sha',
			})
		).toBe('github-sha');
	});

	it('uses an explicit unknown value when build metadata is unavailable', () => {
		expect(resolveServerBuildSha({ MCP_SERVER_BUILD_SHA: ' unknown ' })).toBe('unknown');
	});
});
