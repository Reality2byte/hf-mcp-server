import fs from 'node:fs/promises';
import type { SkillCatalog, SkillResource } from './skill-types.js';

export const SKILL_INDEX_URI = 'skill://index.json';

export interface ListedSkillResource {
	uri: string;
	name: string;
	description?: string;
	mimeType?: string;
}

interface BaseSkillResourceContent {
	uri: string;
	mimeType: string;
}

export type SkillResourceContent =
	| (BaseSkillResourceContent & { text: string })
	| (BaseSkillResourceContent & { blob: string });

export function skillResourceName(skill: SkillResource): string {
	return skill.type === 'archive' ? `${skill.name}.tar.gz` : skill.name;
}

export function listSkillResources(catalog: SkillCatalog): ListedSkillResource[] {
	return [
		...catalog.skills.map((skill) => ({
			uri: skill.url,
			name: skillResourceName(skill),
			description: skill.description,
			mimeType: skill.mimeType,
		})),
		{
			uri: SKILL_INDEX_URI,
			name: 'Skills Index',
			description: 'Catalog of skills exposed by this server (Agent Skills discovery schema).',
			mimeType: 'application/json',
		},
	];
}

export async function readSkillResource(catalog: SkillCatalog, uri: string): Promise<SkillResourceContent | null> {
	if (uri === SKILL_INDEX_URI) {
		return { uri, mimeType: 'application/json', text: catalog.indexText };
	}

	const skill = catalog.skills.find((candidate) => candidate.url === uri);
	if (!skill) return null;

	return readSkillFile(skill);
}

export async function readSkillFile(skill: SkillResource): Promise<SkillResourceContent> {
	const buf = await fs.readFile(skill.absPath);
	return skill.isText
		? { uri: skill.url, mimeType: skill.mimeType, text: buf.toString('utf8') }
		: { uri: skill.url, mimeType: skill.mimeType, blob: buf.toString('base64') };
}
