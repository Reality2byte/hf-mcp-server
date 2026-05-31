import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import tar from 'tar-stream';
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

function extractTar(tarBytes: Buffer): Promise<Record<string, string>> {
	return new Promise((resolve, reject) => {
		const out: Record<string, string> = {};
		const extract = tar.extract();
		extract.on('entry', (header, stream, next) => {
			const parts: Buffer[] = [];
			stream.on('data', (c: Buffer) => parts.push(c));
			stream.on('end', () => {
				out[header.name] = Buffer.concat(parts).toString('utf8');
				next();
			});
			stream.on('error', reject);
			stream.resume();
		});
		extract.on('finish', () => resolve(out));
		extract.on('error', reject);
		extract.end(tarBytes);
	});
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
			'skill://alpha.tar.gz',
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
			{
				name: 'alpha',
				type: 'archive',
				description: 'first skill',
				url: 'skill://alpha.tar.gz',
			},
		]);
	});

	it('registers canonical encoded URIs for files that need escaping', async () => {
		const skillDir = path.join(root, 'with-spaces');
		await mkdir(path.join(skillDir, 'assets'), { recursive: true });
		await writeFile(
			path.join(skillDir, 'SKILL.md'),
			'---\nname: with-spaces\ndescription: filenames need escaping\n---\n# with spaces\n',
			'utf8',
		);
		await writeFile(path.join(skillDir, 'assets', 'foo bar.png'), Buffer.from([0x89, 0x50]));

		const catalog = await loadSkills(root);
		const { server, calls } = makeMockServer();
		registerSkillResources(server, catalog);

		expect(calls.map((c) => c.uri)).toContain('skill://with-spaces/assets/foo%20bar.png');
	});

	it('serves a gzipped tar archive per skill with SKILL.md at the archive root', async () => {
		const skillDir = path.join(root, 'alpha');
		await mkdir(path.join(skillDir, 'scripts'), { recursive: true });
		const skillMd = '---\nname: alpha\ndescription: first skill\n---\n# alpha\n';
		await writeFile(path.join(skillDir, 'SKILL.md'), skillMd, 'utf8');
		await writeFile(path.join(skillDir, 'scripts', 'run.py'), 'print("hi")\n', 'utf8');

		const catalog = await loadSkills(root);
		const { server, calls } = makeMockServer();
		registerSkillResources(server, catalog);

		const archive = calls.find((c) => c.uri === 'skill://alpha.tar.gz')!;
		expect(archive.metadata.mimeType).toBe('application/gzip');

		const content = (await archive.handler()).contents[0];
		expect(content.mimeType).toBe('application/gzip');
		expect(content.text).toBeUndefined();
		expect(content.blob).toBeDefined();

		const tarBytes = gunzipSync(Buffer.from(content.blob!, 'base64'));
		const entries = await extractTar(tarBytes);
		// SKILL.md at the archive root (not nested under the skill name), per SEP-2640.
		expect(entries['SKILL.md']).toBe(skillMd);
		expect(entries['scripts/run.py']).toBe('print("hi")\n');
	});

	it('does not emit an archive for a single-file skill (SKILL.md only)', async () => {
		const skillDir = path.join(root, 'solo');
		await mkdir(skillDir, { recursive: true });
		await writeFile(
			path.join(skillDir, 'SKILL.md'),
			'---\nname: solo\ndescription: just a skill md\n---\n# solo\n',
			'utf8',
		);

		const catalog = await loadSkills(root);
		const { server, calls } = makeMockServer();
		registerSkillResources(server, catalog);

		expect(calls.some((c) => c.uri === 'skill://solo.tar.gz')).toBe(false);

		const index = calls.find((c) => c.uri === 'skill://index.json')!;
		const parsed = JSON.parse((await index.handler()).contents[0].text ?? '');
		expect(parsed.skills).toEqual([
			{
				name: 'solo',
				type: 'skill-md',
				description: 'just a skill md',
				url: 'skill://solo/SKILL.md',
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
