export interface SkillFile {
	relPath: string;
	absPath: string;
	mimeType: string;
	isText: boolean;
}

export interface Skill {
	name: string;
	description: string;
	files: SkillFile[];
}

export interface SkillCatalog {
	skills: Skill[];
}
