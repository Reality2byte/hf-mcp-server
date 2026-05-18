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

let root: string;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'hf-skill-resources-'));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe('registerSkillResources', () => {
	it('registers every skill file plus a skill://index.json discovery resource', async () => {
		const skillDir = path.join(root, 'alpha');
		await mkdir(skillDir, { recursive: true });
		await writeFile(
			path.join(skillDir, 'SKILL.md'),
			'---\nname: alpha\ndescription: first skill\n---\n# alpha\n',
			'utf8',
		);
		await writeFile(path.join(skillDir, 'notes.txt'), 'hello text', 'utf8');
		await writeFile(path.join(skillDir, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));

		const catalog = await loadSkills(root);
		const { server, calls } = makeMockServer();
		registerSkillResources(server, catalog);

		expect(calls.map((c) => c.uri).sort()).toEqual([
			'skill://alpha/SKILL.md',
			'skill://alpha/notes.txt',
			'skill://alpha/pic.png',
			'skill://index.json',
		]);

		const skillMdReg = calls.find((c) => c.uri === 'skill://alpha/SKILL.md')!;
		expect(skillMdReg.metadata.description).toBe('first skill');
		expect(skillMdReg.metadata.mimeType).toBe('text/markdown');

		const index = calls.find((c) => c.uri === 'skill://index.json')!;
		const indexBody = (await index.handler()).contents[0];
		expect(indexBody.mimeType).toBe('application/json');
		const parsed = JSON.parse(indexBody.text ?? '');
		expect(parsed.$schema).toMatch(/agentskills/);
		expect(parsed.skills).toEqual([
			{
				name: 'alpha',
				type: 'skill-md',
				description: 'first skill',
				url: 'skill://alpha/SKILL.md',
			},
		]);
	});

	it('returns text content for text files and base64 blobs for binary files', async () => {
		const skillDir = path.join(root, 'mixed');
		await mkdir(skillDir, { recursive: true });
		await writeFile(
			path.join(skillDir, 'SKILL.md'),
			'---\nname: mixed\ndescription: text + binary\n---\n# mixed\n',
			'utf8',
		);
		await writeFile(path.join(skillDir, 'note.txt'), 'plain text body', 'utf8');
		const binBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		await writeFile(path.join(skillDir, 'pic.png'), binBytes);

		const catalog = await loadSkills(root);
		const { server, calls } = makeMockServer();
		registerSkillResources(server, catalog);

		const txt = calls.find((c) => c.uri === 'skill://mixed/note.txt')!;
		const txtBody = (await txt.handler()).contents[0];
		expect(txtBody.mimeType).toBe('text/plain');
		expect(txtBody.text).toBe('plain text body');
		expect(txtBody.blob).toBeUndefined();

		const png = calls.find((c) => c.uri === 'skill://mixed/pic.png')!;
		const pngBody = (await png.handler()).contents[0];
		expect(pngBody.mimeType).toBe('image/png');
		expect(pngBody.text).toBeUndefined();
		expect(pngBody.blob).toBe(binBytes.toString('base64'));
	});
});
