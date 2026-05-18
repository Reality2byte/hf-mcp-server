import fs from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logger } from '../utils/logger.js';
import { buildSkillUri } from './skill-uri.js';
import type { Skill, SkillCatalog } from './skill-types.js';

const INDEX_URI = 'skill://index.json';
const INDEX_SCHEMA = 'https://schemas.agentskills.io/discovery/0.2.0/schema.json';

interface IndexEntry {
	name: string;
	type: 'skill-md';
	description: string;
	url: string;
}

interface IndexJson {
	$schema: string;
	skills: IndexEntry[];
}

function buildIndex(catalog: SkillCatalog): IndexJson {
	return {
		$schema: INDEX_SCHEMA,
		skills: catalog.skills.map((s) => ({
			name: s.name,
			type: 'skill-md',
			description: s.description,
			url: buildSkillUri(s.name, 'SKILL.md'),
		})),
	};
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
	logger.info({ skills: catalog.skills.length, resources: fileCount + 1 }, 'registered skill resources');
}
