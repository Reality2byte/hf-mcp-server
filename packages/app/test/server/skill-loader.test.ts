import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadSkills } from '../../src/server/skills/skill-loader.js';

let root: string;

async function writeIndex(skills: unknown[]): Promise<void> {
	await writeFile(
		path.join(root, 'index.json'),
		JSON.stringify(
			{
				$schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json',
				skills,
			},
			null,
			2,
		),
		'utf8',
	);
}

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'hf-skill-loader-'));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe('loadSkills', () => {
	it('loads skill resources from a prebuilt distribution index', async () => {
		await mkdir(path.join(root, 'alpha'), { recursive: true });
		await writeFile(path.join(root, 'alpha', 'SKILL.md'), '# alpha\n', 'utf8');
		await writeFile(path.join(root, 'beta.tar.gz'), Buffer.from([0x1f, 0x8b]));
		await writeIndex([
			{
				name: 'alpha',
				type: 'skill-md',
				description: 'first skill',
				url: 'skill://alpha/SKILL.md',
				digest: 'sha256:abc',
			},
			{
				name: 'beta',
				type: 'archive',
				description: 'second skill',
				url: 'skill://beta.tar.gz',
			},
		]);

		const catalog = await loadSkills(root);

		expect(catalog.indexPath).toBe(path.join(root, 'index.json'));
		expect(catalog.indexText).toContain('agentskills');
		expect(catalog.skills).toMatchObject([
			{
				name: 'alpha',
				type: 'skill-md',
				description: 'first skill',
				url: 'skill://alpha/SKILL.md',
				digest: 'sha256:abc',
				mimeType: 'text/markdown',
				isText: true,
			},
			{
				name: 'beta',
				type: 'archive',
				description: 'second skill',
				url: 'skill://beta.tar.gz',
				mimeType: 'application/gzip',
				isText: false,
			},
		]);
	});

	it('ignores sibling source skills tree resources and only loads distribution index entries', async () => {
		const bucketRoot = path.join(root, 'bucket');
		const distributionRoot = path.join(bucketRoot, 'distribution', 'latest');
		const sourceSkillRoot = path.join(bucketRoot, 'skills', 'alpha');
		await mkdir(path.join(distributionRoot, 'alpha'), { recursive: true });
		await mkdir(path.join(sourceSkillRoot, 'assets'), { recursive: true });
		await writeFile(path.join(distributionRoot, 'alpha', 'SKILL.md'), '# alpha distribution\n', 'utf8');
		await writeFile(path.join(sourceSkillRoot, 'SKILL.md'), '# alpha source\n', 'utf8');
		await writeFile(path.join(sourceSkillRoot, 'assets', 'diagram.png'), Buffer.from([0x89, 0x50]));
		await writeFile(
			path.join(distributionRoot, 'index.json'),
			JSON.stringify({
				skills: [
					{
						name: 'alpha',
						type: 'skill-md',
						description: 'first skill',
						url: 'skill://alpha/SKILL.md',
					},
				],
			}),
			'utf8',
		);

		const catalog = await loadSkills(distributionRoot);

		expect(catalog.skills.map((s) => s.url)).toEqual(['skill://alpha/SKILL.md']);
		expect(catalog.compatibilityFiles).toEqual([]);
	});

	it('returns an empty catalog when the index does not exist', async () => {
		const catalog = await loadSkills(path.join(root, 'does-not-exist'));
		expect(catalog.skills).toEqual([]);
		expect(catalog.compatibilityFiles).toEqual([]);
	});

	it('returns an empty catalog when the index is invalid JSON', async () => {
		await writeFile(path.join(root, 'index.json'), '{nope', 'utf8');

		const catalog = await loadSkills(root);

		expect(catalog.skills).toEqual([]);
	});

	it('skips invalid entries and missing resource files', async () => {
		await mkdir(path.join(root, 'valid'), { recursive: true });
		await writeFile(path.join(root, 'valid', 'SKILL.md'), '# valid\n', 'utf8');
		await writeIndex([
			{
				name: 'valid',
				type: 'skill-md',
				description: 'ok',
				url: 'skill://valid/SKILL.md',
			},
			{
				name: 'missing',
				type: 'archive',
				description: 'not present',
				url: 'skill://missing.tar.gz',
			},
			{
				name: 'bad',
				type: 'unknown',
				description: 'bad type',
				url: 'skill://bad/SKILL.md',
			},
		]);

		const catalog = await loadSkills(root);

		expect(catalog.skills.map((s) => s.name)).toEqual(['valid']);
	});

	it('rejects skill URLs that escape the distribution root', async () => {
		await writeFile(path.join(root, 'outside.md'), '# outside\n', 'utf8');
		await writeIndex([
			{
				name: 'escape',
				type: 'skill-md',
				description: 'bad path',
				url: 'skill://../outside.md',
			},
		]);

		const catalog = await loadSkills(root);

		expect(catalog.skills).toEqual([]);
	});

	it('skips symlinked resource files', async () => {
		const target = path.join(root, 'target.md');
		const link = path.join(root, 'linked.md');
		await writeFile(target, '# target\n', 'utf8');
		try {
			await symlink(target, link);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'EPERM') return;
			throw err;
		}
		await writeIndex([
			{
				name: 'linked',
				type: 'skill-md',
				description: 'symlink',
				url: 'skill://linked.md',
			},
		]);

		const catalog = await loadSkills(root);

		expect(catalog.skills).toEqual([]);
	});
});
