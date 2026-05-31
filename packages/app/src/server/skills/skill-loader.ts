import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';
import { buildSkillUri, mimeFor } from './skill-uri.js';
import type { SkillCatalog, SkillCompatibilityFile, SkillResource, SkillResourceType } from './skill-types.js';

const INDEX_FILE = 'index.json';
const SOURCE_SKILLS_DIR = 'skills';
const IGNORED_COMPATIBILITY_NAMES = new Set(['node_modules']);

interface IndexEntry {
	name: unknown;
	type: unknown;
	description: unknown;
	url: unknown;
	digest?: unknown;
}

interface IndexJson {
	skills?: unknown;
}

function emptyCatalog(indexPath: string, indexText = ''): SkillCatalog {
	return { indexPath, indexText, skills: [], compatibilityFiles: [] };
}

function isSkillResourceType(value: unknown): value is SkillResourceType {
	return value === 'skill-md' || value === 'archive';
}

function resolveSkillUrl(rootDir: string, url: string): { absPath: string; relPath: string } | null {
	const prefix = 'skill://';
	if (!url.startsWith(prefix) || url.includes('?') || url.includes('#')) {
		return null;
	}

	const encodedPath = url.slice(prefix.length);
	if (!encodedPath) return null;

	let parts: string[];
	try {
		parts = encodedPath.split('/').map((part) => decodeURIComponent(part));
	} catch {
		return null;
	}

	if (parts.some((part) => !part || part === '.' || part === '..' || path.isAbsolute(part))) {
		return null;
	}

	const absRoot = path.resolve(rootDir);
	const absPath = path.resolve(absRoot, ...parts);
	const relative = path.relative(absRoot, absPath);
	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		return null;
	}

	return { absPath, relPath: parts.join('/') };
}

async function loadIndexEntry(rootDir: string, entry: IndexEntry): Promise<SkillResource | null> {
	if (
		typeof entry.name !== 'string' ||
		!isSkillResourceType(entry.type) ||
		typeof entry.description !== 'string' ||
		typeof entry.url !== 'string'
	) {
		logger.warn({ entry }, 'invalid skill index entry, skipping');
		return null;
	}

	const resolved = resolveSkillUrl(rootDir, entry.url);
	if (!resolved) {
		logger.warn({ url: entry.url }, 'invalid skill resource URL, skipping');
		return null;
	}

	try {
		const stat = await fs.lstat(resolved.absPath);
		if (!stat.isFile() || stat.isSymbolicLink()) {
			logger.warn({ path: resolved.absPath }, 'skill resource is not a regular file, skipping');
			return null;
		}
	} catch (err) {
		logger.warn({ path: resolved.absPath, err }, 'skill resource missing, skipping');
		return null;
	}

	const { mimeType, isText } = mimeFor(resolved.relPath);

	return {
		name: entry.name,
		type: entry.type,
		description: entry.description,
		url: entry.url,
		digest: typeof entry.digest === 'string' ? entry.digest : undefined,
		absPath: resolved.absPath,
		mimeType,
		isText,
	};
}

function findCompatibilitySkillsDir(distributionDir: string): string | null {
	if (path.basename(distributionDir) !== 'latest' || path.basename(path.dirname(distributionDir)) !== 'distribution') {
		return null;
	}
	const parentDir = path.dirname(path.dirname(distributionDir));
	return path.join(parentDir, SOURCE_SKILLS_DIR);
}

async function loadCompatibilitySkillFiles(distributionDir: string): Promise<SkillCompatibilityFile[]> {
	// Compatibility path: older clients consumed every file under `skills/<name>/...`
	// as an individual `skill://<name>/...` resource. The canonical distribution is
	// still `index.json` plus prebuilt archives; this scan only preserves that older
	// per-file resource surface when the source tree is mounted alongside it.
	const skillsDir = findCompatibilitySkillsDir(distributionDir);
	if (!skillsDir) return [];
	const compatibilitySkillsDir = skillsDir;
	const out: SkillCompatibilityFile[] = [];

	async function walkSkill(skillName: string, dir: string): Promise<void> {
		let entries: Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch (err) {
			logger.warn({ dir, err }, 'compatibility skill file walk failed, skipping directory');
			return;
		}

		for (const entry of entries) {
			if (IGNORED_COMPATIBILITY_NAMES.has(entry.name) || entry.name.startsWith('.')) continue;
			const absPath = path.join(dir, entry.name);
			const stat = await fs.lstat(absPath);
			if (stat.isSymbolicLink()) {
				logger.warn({ absPath }, 'skipping symlink in compatibility skill directory');
				continue;
			}

			if (entry.isDirectory()) {
				await walkSkill(skillName, absPath);
				continue;
			}
			if (!entry.isFile()) continue;

			const skillDir = path.join(compatibilitySkillsDir, skillName);
			const relPath = path.relative(skillDir, absPath).split(path.sep).join('/');
			const { mimeType, isText } = mimeFor(relPath);
			out.push({
				resourceName: relPath === 'SKILL.md' ? skillName : `${skillName}/${relPath}`,
				url: buildSkillUri(skillName, relPath),
				absPath,
				mimeType,
				isText,
			});
		}
	}

	let skillDirs: Dirent[];
	try {
		skillDirs = await fs.readdir(compatibilitySkillsDir, { withFileTypes: true });
	} catch (err) {
		logger.warn(
			{ skillsDir: compatibilitySkillsDir, err },
			'compatibility skills directory not found, skipping per-file resources',
		);
		return [];
	}

	for (const entry of skillDirs) {
		if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
		await walkSkill(entry.name, path.join(compatibilitySkillsDir, entry.name));
	}

	return out;
}

export async function loadSkills(rootDir: string): Promise<SkillCatalog> {
	const indexPath = path.join(rootDir, INDEX_FILE);
	let indexText: string;
	try {
		indexText = await fs.readFile(indexPath, 'utf8');
	} catch (err) {
		logger.warn({ indexPath, err }, 'skills index not found, skills disabled');
		return emptyCatalog(indexPath);
	}

	let parsed: IndexJson;
	try {
		parsed = JSON.parse(indexText) as IndexJson;
	} catch (err) {
		logger.warn({ indexPath, err }, 'skills index is invalid JSON, skills disabled');
		return emptyCatalog(indexPath, indexText);
	}

	if (!Array.isArray(parsed.skills)) {
		logger.warn({ indexPath }, 'skills index missing skills array, skills disabled');
		return emptyCatalog(indexPath, indexText);
	}

	const skills: SkillResource[] = [];
	const seenUrls = new Set<string>();
	for (const entry of parsed.skills as IndexEntry[]) {
		const skill = await loadIndexEntry(rootDir, entry);
		if (!skill) continue;
		if (seenUrls.has(skill.url)) {
			logger.warn({ url: skill.url }, 'duplicate skill resource URL, skipping');
			continue;
		}
		seenUrls.add(skill.url);
		skills.push(skill);
	}

	const compatibilityFiles = await loadCompatibilitySkillFiles(rootDir);

	logger.info({ rootDir, count: skills.length, compatibilityFiles: compatibilityFiles.length }, 'loaded skills');
	return { indexPath, indexText, skills, compatibilityFiles };
}
