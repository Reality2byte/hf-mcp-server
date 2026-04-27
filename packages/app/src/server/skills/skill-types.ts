export interface SkillFile {
	relPath: string;
	absPath: string;
	mimeType: string;
	isText: boolean;
}

export interface Skill {
	name: string;
	dirName: string;
	description: string;
	rootDir: string;
	files: SkillFile[];
	frontmatter: Record<string, unknown>;
}

export interface SkillCatalog {
	rootDir: string;
	skills: Skill[];
}
