import fs from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logger } from '../utils/logger.js';
import type { SkillCatalog, SkillCompatibilityFile, SkillResource } from './skill-types.js';

const INDEX_URI = 'skill://index.json';

function registerSkillResource(server: McpServer, skill: SkillResource): void {
	const resourceName = skill.type === 'archive' ? `${skill.name}.tar.gz` : skill.name;
	server.registerResource(
		resourceName,
		skill.url,
		{
			description: skill.description,
			mimeType: skill.mimeType,
		},
		async () => {
			const buf = await fs.readFile(skill.absPath);
			return {
				contents: [
					skill.isText
						? { uri: skill.url, mimeType: skill.mimeType, text: buf.toString('utf8') }
						: { uri: skill.url, mimeType: skill.mimeType, blob: buf.toString('base64') },
				],
			};
		},
	);
}

function registerCompatibilityFileResource(server: McpServer, file: SkillCompatibilityFile): void {
	server.registerResource(
		file.resourceName,
		file.url,
		{
			mimeType: file.mimeType,
		},
		async () => {
			const buf = await fs.readFile(file.absPath);
			return {
				contents: [
					file.isText
						? { uri: file.url, mimeType: file.mimeType, text: buf.toString('utf8') }
						: { uri: file.url, mimeType: file.mimeType, blob: buf.toString('base64') },
				],
			};
		},
	);
}

export function registerSkillResources(server: McpServer, catalog: SkillCatalog): void {
	for (const skill of catalog.skills) {
		registerSkillResource(server, skill);
	}

	// Compatibility resources: older clients expected individual files from the
	// mounted `skills/` source tree to be addressable as `skill://<name>/...`.
	// The primary discovery surface remains the prebuilt distribution index and
	// archives above; these extra registrations preserve the previous PR behavior.
	const canonicalUrls = new Set(catalog.skills.map((skill) => skill.url));
	let compatibilityCount = 0;
	for (const file of catalog.compatibilityFiles) {
		if (canonicalUrls.has(file.url)) continue;
		registerCompatibilityFileResource(server, file);
		compatibilityCount += 1;
	}

	server.registerResource(
		'Skills Index',
		INDEX_URI,
		{
			description: 'Catalog of skills exposed by this server (Agent Skills discovery schema).',
			mimeType: 'application/json',
		},
		async () => ({
			contents: [{ uri: INDEX_URI, mimeType: 'application/json', text: catalog.indexText }],
		}),
	);

	const resources = catalog.skills.length + compatibilityCount + 1;
	logger.info(
		{ skills: catalog.skills.length, compatibilityFiles: compatibilityCount, resources },
		'registered skill resources',
	);
}
