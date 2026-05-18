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
}

export interface SkillCatalog {
	rootDir: string;
	skills: Skill[];
}
