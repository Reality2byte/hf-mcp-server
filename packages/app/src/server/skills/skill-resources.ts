import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logger } from '../utils/logger.js';
import type { SkillCatalog, SkillResource } from './skill-types.js';
import { listSkillResources, readSkillFile, skillResourceName, SKILL_INDEX_URI } from './skill-resource-data.js';

function registerSkillResource(server: McpServer, skill: SkillResource): void {
	server.registerResource(
		skillResourceName(skill),
		skill.url,
		{
			description: skill.description,
			mimeType: skill.mimeType,
		},
		async () => {
			const content = await readSkillFile(skill);
			return { contents: [content] };
		},
	);
}

export function registerSkillResources(server: McpServer, catalog: SkillCatalog): void {
	for (const skill of catalog.skills) {
		registerSkillResource(server, skill);
	}

	server.registerResource(
		'Skills Index',
		SKILL_INDEX_URI,
		{
			description: 'Catalog of skills exposed by this server (Agent Skills discovery schema).',
			mimeType: 'application/json',
		},
		async () => ({
			contents: [{ uri: SKILL_INDEX_URI, mimeType: 'application/json', text: catalog.indexText }],
		}),
	);

	const resources = listSkillResources(catalog).length;
	logger.info({ skills: catalog.skills.length, resources }, 'registered skill resources');
}
