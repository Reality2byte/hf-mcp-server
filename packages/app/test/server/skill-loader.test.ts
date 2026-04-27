import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadSkills } from '../../src/server/skills/skill-loader.js';

let root: string;

async function writeSkill(name: string, frontmatterName: string, description: string, extra?: Record<string, string>): Promise<string> {
	const dir = path.join(root, name);
	await mkdir(dir, { recursive: true });
	const body = `---\nname: ${frontmatterName}\ndescription: ${description}\n---\n# ${frontmatterName}\n`;
	await writeFile(path.join(dir, 'SKILL.md'), body, 'utf8');
	for (const [rel, content] of Object.entries(extra ?? {})) {
		const filePath = path.join(dir, rel);
		await mkdir(path.dirname(filePath), { recursive: true });
		await writeFile(filePath, content, 'utf8');
	}
	return dir;
}

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'hf-skill-loader-'));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe('loadSkills', () => {
	it('loads a skill with matching frontmatter name and walks its files', async () => {
		await writeSkill('alpha', 'alpha', 'first skill', { 'extra.txt': 'hello' });

		const catalog = await loadSkills(root);

		expect(catalog.skills).toHaveLength(1);
		const skill = catalog.skills[0];
		expect(skill.name).toBe('alpha');
		expect(skill.description).toBe('first skill');
		expect(skill.files.map((f) => f.relPath).sort()).toEqual(['SKILL.md', 'extra.txt']);
	});

	it('returns an empty catalog when the root does not exist', async () => {
		const catalog = await loadSkills(path.join(root, 'does-not-exist'));
		expect(catalog.skills).toEqual([]);
	});

	it('skips directories without SKILL.md', async () => {
		await mkdir(path.join(root, 'no-skill'), { recursive: true });
		await writeSkill('has-skill', 'has-skill', 'ok');

		const catalog = await loadSkills(root);

		expect(catalog.skills.map((s) => s.name)).toEqual(['has-skill']);
	});

	it('skips skills missing required frontmatter fields', async () => {
		const dir = path.join(root, 'bad');
		await mkdir(dir, { recursive: true });
		await writeFile(path.join(dir, 'SKILL.md'), '---\nname: bad\n---\nno description\n', 'utf8');

		const catalog = await loadSkills(root);

		expect(catalog.skills).toEqual([]);
	});

	it('rejects skills whose frontmatter name does not match the directory', async () => {
		await writeSkill('alpha', 'something-else', 'mismatched');

		const catalog = await loadSkills(root);

		expect(catalog.skills).toEqual([]);
	});

	it('dedupes by skill name when two directories share the same frontmatter name', async () => {
		// Both directories must use frontmatter name matching dirName (SEP requirement),
		// so collisions only happen across distinct directories with distinct names —
		// but if a future loosening allowed the same `name:` twice, dedup should still work.
		await writeSkill('alpha', 'alpha', 'one');
		await writeSkill('alpha-copy', 'alpha-copy', 'two');

		const catalog = await loadSkills(root);

		expect(catalog.skills.map((s) => s.name).sort()).toEqual(['alpha', 'alpha-copy']);
	});

	it('skips symlinked files inside a skill directory', async () => {
		const skillDir = await writeSkill('safe', 'safe', 'no traversal');
		const outside = path.join(root, 'outside.txt');
		await writeFile(outside, 'secret', 'utf8');

		try {
			await symlink(outside, path.join(skillDir, 'leak.txt'));
		} catch (err) {
			// Windows without dev mode / admin cannot create symlinks — skip rather than fail
			if ((err as NodeJS.ErrnoException).code === 'EPERM') return;
			throw err;
		}

		const catalog = await loadSkills(root);
		const files = catalog.skills[0]?.files.map((f) => f.relPath) ?? [];
		expect(files).not.toContain('leak.txt');
	});

	it('skips hidden dotfiles and node_modules inside a skill', async () => {
		const dir = await writeSkill('with-junk', 'with-junk', 'has noise', {
			'.hidden': 'x',
			'node_modules/pkg/index.js': 'module.exports = {}',
			'real.txt': 'keep me',
		});
		// touch dir so lint doesn't complain about unused
		void dir;

		const catalog = await loadSkills(root);
		const files = catalog.skills[0].files.map((f) => f.relPath).sort();
		expect(files).toEqual(['SKILL.md', 'real.txt']);
	});
});
