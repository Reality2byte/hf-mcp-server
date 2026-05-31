import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { logger } from '../utils/logger.js';
import { mimeFor } from './skill-uri.js';
import type { Skill, SkillCatalog, SkillFile } from './skill-types.js';

const SKILL_FILE = 'SKILL.md';
const IGNORE_NAMES = new Set(['node_modules']);

async function walkFiles(skillDir: string): Promise<SkillFile[]> {
	const out: SkillFile[] = [];

	async function walk(dir: string): Promise<void> {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (IGNORE_NAMES.has(entry.name) || entry.name.startsWith('.')) continue;
			const abs = path.join(dir, entry.name);

			// Reject symlinks defensively — we don't want a malicious skill to point outside its root.
			const lst = await fs.lstat(abs);
			if (lst.isSymbolicLink()) {
				logger.warn({ abs }, 'skipping symlink in skill directory');
				continue;
			}

			if (entry.isDirectory()) {
				await walk(abs);
			} else if (entry.isFile()) {
				const relPath = path.relative(skillDir, abs).split(path.sep).join('/');
				const { mimeType, isText } = mimeFor(relPath);
				out.push({ relPath, absPath: abs, mimeType, isText, mode: lst.mode });
			}
		}
	}

	await walk(skillDir);
	return out;
}

async function loadSkill(skillDir: string, dirName: string): Promise<Skill | null> {
	const skillMdPath = path.join(skillDir, SKILL_FILE);
	let raw: string;
	try {
		raw = await fs.readFile(skillMdPath, 'utf8');
	} catch (err) {
		logger.warn({ dirName, err }, 'skill missing SKILL.md, skipping');
		return null;
	}

	const { data } = matter(raw);
	const name = typeof data.name === 'string' ? data.name : undefined;
	const description = typeof data.description === 'string' ? data.description : undefined;

	if (!name || !description) {
		logger.warn({ dirName }, 'skill SKILL.md missing required name/description frontmatter, skipping');
		return null;
	}
	if (name !== dirName) {
		logger.warn(
			{ dirName, frontmatterName: name },
			'skill SKILL.md frontmatter name must match directory name (SEP requirement), skipping',
		);
		return null;
	}

	let files: SkillFile[];
	try {
		files = await walkFiles(skillDir);
	} catch (err) {
		logger.warn({ dirName, err }, 'skill file walk failed, skipping');
		return null;
	}
	if (!files.some((f) => f.relPath === SKILL_FILE)) {
		// e.g. SKILL.md is a symlink (skipped during walk) — index would advertise a non-existent resource.
		logger.warn({ dirName }, 'skill walk did not include SKILL.md, skipping');
		return null;
	}

	return { name, description, files };
}

export async function loadSkills(rootDir: string): Promise<SkillCatalog> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(rootDir, { withFileTypes: true });
	} catch (err) {
		logger.warn({ rootDir, err }, 'skills root not found, skills disabled');
		return { skills: [] };
	}

	const skills: Skill[] = [];
	const seenNames = new Set<string>();
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
		const skillDir = path.join(rootDir, entry.name);
		const skill = await loadSkill(skillDir, entry.name);
		if (!skill) continue;
		if (seenNames.has(skill.name)) {
			logger.warn({ name: skill.name }, 'duplicate skill name, skipping');
			continue;
		}
		seenNames.add(skill.name);
		skills.push(skill);
	}

	logger.info({ rootDir, count: skills.length }, 'loaded skills');
	return { skills };
}
