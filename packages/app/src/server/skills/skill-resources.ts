import fs from 'node:fs/promises';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import tar from 'tar-stream';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logger } from '../utils/logger.js';
import { buildArchiveUri, buildSkillUri } from './skill-uri.js';
import type { Skill, SkillCatalog } from './skill-types.js';

const INDEX_URI = 'skill://index.json';
// Tracks the Agent Skills discovery schema version referenced by draft SEP-2640.
// Bump alongside SEP updates.
const INDEX_SCHEMA = 'https://schemas.agentskills.io/discovery/0.2.0/schema.json';

const gzipAsync = promisify(gzip);
// Fixed epoch for tar entry mtimes so a skill's archive bytes are reproducible
// (independent of file timestamps), which keeps the cached buffer stable.
const ARCHIVE_MTIME = new Date(0);

interface IndexEntry {
	name: string;
	type: 'skill-md' | 'archive';
	description: string;
	url: string;
}

interface IndexJson {
	$schema: string;
	skills: IndexEntry[];
}

// A skill is worth archiving only when it ships more than just SKILL.md; a
// single-file skill is already fully covered by its skill-md resource.
function isMultiFile(skill: Skill): boolean {
	return skill.files.length > 1;
}

function buildIndex(catalog: SkillCatalog): IndexJson {
	// SEP-2640 uses a single-pointer model per entry. Every skill gets a
	// `skill-md` entry (per-file resources, lazy-loaded by non-shell clients);
	// multi-file skills additionally get an `archive` entry (one .tar.gz install
	// artifact for shell-enabled agents).
	return {
		$schema: INDEX_SCHEMA,
		skills: catalog.skills.flatMap((s) => {
			const entries: IndexEntry[] = [
				{
					name: s.name,
					type: 'skill-md',
					description: s.description,
					url: buildSkillUri(s.name, 'SKILL.md'),
				},
			];
			if (isMultiFile(s)) {
				entries.push({
					name: s.name,
					type: 'archive',
					description: s.description,
					url: buildArchiveUri(s.name),
				});
			}
			return entries;
		}),
	};
}

// Built lazily on first archive read and memoized per Skill. getSkillCatalog()
// caches the same Skill objects across sessions, so each archive is generated
// once regardless of how many sessions register resources.
const archiveCache = new WeakMap<Skill, Promise<Buffer>>();

async function buildSkillArchive(skill: Skill): Promise<Buffer> {
	const pack = tar.pack();
	const chunks: Buffer[] = [];
	pack.on('data', (chunk: Buffer) => chunks.push(chunk));
	const done = new Promise<void>((resolve, reject) => {
		pack.on('end', resolve);
		pack.on('error', reject);
	});

	for (const file of skill.files) {
		const buf = await fs.readFile(file.absPath);
		// Preserve the executable bit (normalised to 0o755/0o644 so the bytes stay
		// deterministic regardless of the source umask) — a skill may ship runnable
		// scripts that a shell agent installs from the archive.
		const mode = (file.mode & 0o111) !== 0 ? 0o755 : 0o644;
		// `relPath` is relative to the skill dir, so SKILL.md lands at the archive
		// root as SEP-2640 requires (entries are not nested under the skill name).
		await new Promise<void>((resolve, reject) => {
			pack.entry({ name: file.relPath, mode, mtime: ARCHIVE_MTIME, type: 'file' }, buf, (err) => {
				if (err) reject(err);
				else resolve();
			});
		});
	}
	pack.finalize();
	await done;

	// Node's gzip writes a zeroed MTIME header field, so the output is stable.
	return gzipAsync(Buffer.concat(chunks));
}

function getSkillArchive(skill: Skill): Promise<Buffer> {
	let cached = archiveCache.get(skill);
	if (!cached) {
		cached = buildSkillArchive(skill);
		archiveCache.set(skill, cached);
	}
	return cached;
}

function registerSkillArchive(server: McpServer, skill: Skill): void {
	const uri = buildArchiveUri(skill.name);
	server.registerResource(
		`${skill.name}.tar.gz`,
		uri,
		{
			description: skill.description,
			mimeType: 'application/gzip',
		},
		async () => {
			const buf = await getSkillArchive(skill);
			return {
				contents: [{ uri, mimeType: 'application/gzip', blob: buf.toString('base64') }],
			};
		},
	);
}

function registerSkillFile(server: McpServer, skill: Skill, file: Skill['files'][number]): void {
	const uri = buildSkillUri(skill.name, file.relPath);
	const isSkillMd = file.relPath === 'SKILL.md';
	const resourceName = isSkillMd ? skill.name : `${skill.name}/${file.relPath}`;
	server.registerResource(
		resourceName,
		uri,
		{
			description: isSkillMd ? skill.description : undefined,
			mimeType: file.mimeType,
		},
		async () => {
			const buf = await fs.readFile(file.absPath);
			return {
				contents: [
					file.isText
						? { uri, mimeType: file.mimeType, text: buf.toString('utf8') }
						: { uri, mimeType: file.mimeType, blob: buf.toString('base64') },
				],
			};
		},
	);
}

export function registerSkillResources(server: McpServer, catalog: SkillCatalog): void {
	for (const skill of catalog.skills) {
		for (const file of skill.files) {
			registerSkillFile(server, skill, file);
		}
		if (isMultiFile(skill)) {
			registerSkillArchive(server, skill);
		}
	}

	const indexJson = buildIndex(catalog);
	const indexBody = JSON.stringify(indexJson, null, 2);
	server.registerResource(
		'Skills Index',
		INDEX_URI,
		{
			description: 'Catalog of skills exposed by this server (Agent Skills discovery schema).',
			mimeType: 'application/json',
		},
		async () => ({
			contents: [{ uri: INDEX_URI, mimeType: 'application/json', text: indexBody }],
		}),
	);

	const fileCount = catalog.skills.reduce((acc, s) => acc + s.files.length, 0);
	const archiveCount = catalog.skills.filter(isMultiFile).length;
	// Per-file resources + one .tar.gz archive per multi-file skill + the index.json.
	const resources = fileCount + archiveCount + 1;
	logger.info({ skills: catalog.skills.length, resources }, 'registered skill resources');
}
