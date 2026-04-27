import { describe, expect, it } from 'vitest';
import { buildSkillUri, mimeFor, parseSkillUri } from '../../src/server/skills/skill-uri.js';

describe('parseSkillUri', () => {
	it('parses a valid skill uri', () => {
		expect(parseSkillUri('skill://my-skill/SKILL.md')).toEqual({
			skillName: 'my-skill',
			relPath: 'SKILL.md',
		});
	});

	it('parses nested paths', () => {
		expect(parseSkillUri('skill://my-skill/assets/diagram.png')).toEqual({
			skillName: 'my-skill',
			relPath: 'assets/diagram.png',
		});
	});

	it('rejects uri with wrong scheme', () => {
		expect(parseSkillUri('https://example.com/x')).toBeNull();
		expect(parseSkillUri('file:///etc/passwd')).toBeNull();
	});

	it('rejects uri with no slash after host', () => {
		expect(parseSkillUri('skill://only-name')).toBeNull();
	});

	it('rejects uri with empty skill name', () => {
		expect(parseSkillUri('skill:///SKILL.md')).toBeNull();
	});

	it('rejects uri with empty rel path', () => {
		expect(parseSkillUri('skill://my-skill/')).toBeNull();
	});

	it('rejects empty string', () => {
		expect(parseSkillUri('')).toBeNull();
	});
});

describe('buildSkillUri', () => {
	it('produces a skill uri for a single file', () => {
		expect(buildSkillUri('my-skill', 'SKILL.md')).toBe('skill://my-skill/SKILL.md');
	});

	it('normalises backslashes to forward slashes', () => {
		expect(buildSkillUri('my-skill', 'assets\\diagram.png')).toBe('skill://my-skill/assets/diagram.png');
	});

	it('round-trips through parseSkillUri', () => {
		const uri = buildSkillUri('skill-a', 'docs/guide.md');
		expect(parseSkillUri(uri)).toEqual({ skillName: 'skill-a', relPath: 'docs/guide.md' });
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
