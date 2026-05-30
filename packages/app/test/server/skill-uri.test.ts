import { describe, expect, it } from 'vitest';
import { buildSkillUri, mimeFor } from '../../src/server/skills/skill-uri.js';

describe('buildSkillUri', () => {
	it('produces a skill uri for a single file', () => {
		expect(buildSkillUri('my-skill', 'SKILL.md')).toBe('skill://my-skill/SKILL.md');
	});

	it('normalises backslashes to forward slashes', () => {
		expect(buildSkillUri('my-skill', 'assets\\diagram.png')).toBe('skill://my-skill/assets/diagram.png');
	});

	it('encodes skill names and path segments', () => {
		expect(buildSkillUri('my skill', 'assets/foo bar(1).png')).toBe('skill://my%20skill/assets/foo%20bar(1).png');
	});
});

describe('mimeFor', () => {
	it('maps markdown as text', () => {
		expect(mimeFor('SKILL.md')).toEqual({ mimeType: 'text/markdown', isText: true });
	});

	it('maps python as text', () => {
		expect(mimeFor('scripts/run.py')).toEqual({ mimeType: 'text/x-python', isText: true });
	});

	it('maps png as binary', () => {
		expect(mimeFor('assets/diagram.png')).toEqual({ mimeType: 'image/png', isText: false });
	});

	it('special-cases LICENSE files', () => {
		expect(mimeFor('LICENSE')).toEqual({ mimeType: 'text/plain', isText: true });
		expect(mimeFor('license.txt')).toEqual({ mimeType: 'text/plain', isText: true });
	});

	it('falls back to octet-stream for unknown extensions', () => {
		expect(mimeFor('mystery.xyz')).toEqual({ mimeType: 'application/octet-stream', isText: false });
	});

	it('handles uppercase extensions', () => {
		expect(mimeFor('NOTES.MD')).toEqual({ mimeType: 'text/markdown', isText: true });
	});
});
