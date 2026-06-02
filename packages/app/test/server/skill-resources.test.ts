import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadSkills } from '../../src/server/skills/skill-loader.js';
import { registerSkillResources } from '../../src/server/skills/skill-resources.js';

type ResourceContent = { uri: string; mimeType: string; text?: string; blob?: string };
type ResourceHandler = () => Promise<{ contents: ResourceContent[] }>;

interface Registration {
	name: string;
	uri: string;
	metadata: { description?: string; mimeType?: string };
	handler: ResourceHandler;
}

function makeMockServer(): { server: McpServer; calls: Registration[] } {
	const calls: Registration[] = [];
	const server = {
		registerResource(
			name: string,
			uri: string,
			metadata: Registration['metadata'],
			handler: ResourceHandler,
		): void {
			calls.push({ name, uri, metadata, handler });
		},
	} as unknown as McpServer;
	return { server, calls };
}

async function writeIndex(root: string): Promise<void> {
	await writeFile(
		path.join(root, 'index.json'),
		JSON.stringify(
			{
				$schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json',
				skills: [
					{
						name: 'alpha',
						type: 'skill-md',
						description: 'first skill',
						url: 'skill://alpha/SKILL.md',
						digest: 'sha256:alpha',
					},
					{
						name: 'beta',
						type: 'archive',
						description: 'archive skill',
						url: 'skill://beta.tar.gz',
						digest: 'sha256:beta',
					},
				],
			},
			null,
			2,
		),
		'utf8',
	);
}

let root: string;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'hf-skill-resources-'));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe('registerSkillResources', () => {
	it('registers the prebuilt index and each referenced distribution file', async () => {
		await mkdir(path.join(root, 'alpha'), { recursive: true });
		await writeFile(path.join(root, 'alpha', 'SKILL.md'), '# alpha\n', 'utf8');
		await writeFile(path.join(root, 'beta.tar.gz'), Buffer.from([0x1f, 0x8b, 0x08]));
		await writeIndex(root);

		const catalog = await loadSkills(root);
		const { server, calls } = makeMockServer();
		registerSkillResources(server, catalog);

		expect(calls.map((c) => c.uri).sort()).toEqual([
			'skill://alpha/SKILL.md',
			'skill://beta.tar.gz',
			'skill://index.json',
		]);

		const skillMdReg = calls.find((c) => c.uri === 'skill://alpha/SKILL.md')!;
		expect(skillMdReg.name).toBe('alpha');
		expect(skillMdReg.metadata.description).toBe('first skill');
		expect(skillMdReg.metadata.mimeType).toBe('text/markdown');

		const archiveReg = calls.find((c) => c.uri === 'skill://beta.tar.gz')!;
		expect(archiveReg.name).toBe('beta.tar.gz');
		expect(archiveReg.metadata.description).toBe('archive skill');
		expect(archiveReg.metadata.mimeType).toBe('application/gzip');
	});

	it('does not register source-tree files outside the distribution index', async () => {
		const bucketRoot = path.join(root, 'bucket');
		const distributionRoot = path.join(bucketRoot, 'distribution', 'latest');
		const sourceSkillRoot = path.join(bucketRoot, 'skills', 'alpha');
		await mkdir(path.join(distributionRoot, 'alpha'), { recursive: true });
		await mkdir(path.join(sourceSkillRoot, 'assets'), { recursive: true });
		await writeFile(path.join(distributionRoot, 'alpha', 'SKILL.md'), '# alpha distribution\n', 'utf8');
		await writeFile(path.join(distributionRoot, 'beta.tar.gz'), Buffer.from([0x1f, 0x8b, 0x08]));
		await writeFile(path.join(sourceSkillRoot, 'SKILL.md'), '# alpha source\n', 'utf8');
		await writeFile(path.join(sourceSkillRoot, 'assets', 'notes.txt'), 'compat notes', 'utf8');
		await writeIndex(distributionRoot);

		const catalog = await loadSkills(distributionRoot);
		const { server, calls } = makeMockServer();
		registerSkillResources(server, catalog);

		expect(calls.map((c) => c.uri).sort()).toEqual([
			'skill://alpha/SKILL.md',
			'skill://beta.tar.gz',
			'skill://index.json',
		]);

		const skillMdRegs = calls.filter((c) => c.uri === 'skill://alpha/SKILL.md');
		expect(skillMdRegs).toHaveLength(1);

		expect(calls.find((c) => c.uri === 'skill://alpha/assets/notes.txt')).toBeUndefined();
	});

	it('serves index.json exactly as provided by the distribution', async () => {
		await mkdir(path.join(root, 'alpha'), { recursive: true });
		await writeFile(path.join(root, 'alpha', 'SKILL.md'), '# alpha\n', 'utf8');
		await writeFile(path.join(root, 'beta.tar.gz'), Buffer.from([0x1f, 0x8b, 0x08]));
		await writeIndex(root);

		const catalog = await loadSkills(root);
		const { server, calls } = makeMockServer();
		registerSkillResources(server, catalog);

		const index = calls.find((c) => c.uri === 'skill://index.json')!;
		const indexBody = (await index.handler()).contents[0];
		expect(indexBody.mimeType).toBe('application/json');
		expect(indexBody.text).toBe(catalog.indexText);
		expect(indexBody.blob).toBeUndefined();
	});

	it('returns text content for skill-md resources and base64 blobs for archives', async () => {
		const skillMd = '# alpha\n';
		const archiveBytes = Buffer.from([0x1f, 0x8b, 0x08]);
		await mkdir(path.join(root, 'alpha'), { recursive: true });
		await writeFile(path.join(root, 'alpha', 'SKILL.md'), skillMd, 'utf8');
		await writeFile(path.join(root, 'beta.tar.gz'), archiveBytes);
		await writeIndex(root);

		const catalog = await loadSkills(root);
		const { server, calls } = makeMockServer();
		registerSkillResources(server, catalog);

		const skillMdReg = calls.find((c) => c.uri === 'skill://alpha/SKILL.md')!;
		const skillMdBody = (await skillMdReg.handler()).contents[0];
		expect(skillMdBody.mimeType).toBe('text/markdown');
		expect(skillMdBody.text).toBe(skillMd);
		expect(skillMdBody.blob).toBeUndefined();

		const archiveReg = calls.find((c) => c.uri === 'skill://beta.tar.gz')!;
		const archiveBody = (await archiveReg.handler()).contents[0];
		expect(archiveBody.mimeType).toBe('application/gzip');
		expect(archiveBody.text).toBeUndefined();
		expect(archiveBody.blob).toBe(archiveBytes.toString('base64'));
	});
});
