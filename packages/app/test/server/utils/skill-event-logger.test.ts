import { describe, expect, it } from 'vitest';
import { buildSkillLogEntry, type SkillEventLoggerOptions } from '../../../src/server/utils/skill-event-logger.js';

describe('buildSkillLogEntry', () => {
	it('retains the requested target while excluding other request and response data', () => {
		const targetUri = 'skill://private-org/private-skill/SKILL.md';
		const excludedValues = {
			cursor: 'private-cursor',
			content: 'PRIVATE_SKILL_CONTENT',
			errorMessage: 'Unknown skill URI: skill://private-org/private-skill/SKILL.md',
		};
		const options = {
			clientSessionId: 'session-1',
			requestId: 'request-1',
			protocolEra: 'modern',
			protocolVersion: '2026-07-28',
			userHash: 'user-hash',
			isAuthenticated: true,
			clientName: 'test-client',
			clientVersion: '1.2.3',
			durationMs: 12.6,
			success: true,
			cursorSupplied: true,
			targetUri,
			responseItemCount: 2,
			...excludedValues,
		} satisfies SkillEventLoggerOptions & typeof excludedValues;

		const entry = buildSkillLogEntry('skills/get', options);

		expect(entry).toMatchObject({
			clientSessionId: 'session-1',
			requestId: 'request-1',
			protocolEra: 'modern',
			protocolVersion: '2026-07-28',
			userHash: 'user-hash',
			name: 'test-client',
			version: '1.2.3',
			methodName: 'skills/get',
			authorized: true,
			durationMs: 13,
			success: true,
			cursorSupplied: true,
			targetUri,
			responseItemCount: 2,
		});
		expect(Object.keys(entry).sort()).toEqual(
			[
				'authorized',
				'clientSessionId',
				'cursorSupplied',
				'durationMs',
				'mcpServerSessionId',
				'methodName',
				'name',
				'protocolEra',
				'protocolVersion',
				'requestId',
				'responseItemCount',
				'serverBuildSha',
				'serverVersion',
				'success',
				'targetUri',
				'userHash',
				'version',
			].sort()
		);

		const serialized = JSON.stringify(entry);
		expect(serialized).toContain(targetUri);
		for (const excludedValue of Object.values(excludedValues)) {
			expect(serialized).not.toContain(excludedValue);
		}
	});

	it('normalizes duration and rejects invalid response counts', () => {
		const entry = buildSkillLogEntry('skills/resource-read', {
			protocolEra: 'legacy',
			isAuthenticated: false,
			durationMs: -1.6,
			success: false,
			cursorSupplied: false,
			responseItemCount: Number.NaN,
		});

		expect(entry.durationMs).toBe(0);
		expect(entry.targetUri).toBeNull();
		expect(entry.responseItemCount).toBeNull();
	});
});
