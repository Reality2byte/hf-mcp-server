export interface SkillFile {
	relPath: string;
	absPath: string;
	mimeType: string;
	isText: boolean;
	// Unix file mode (from lstat). Used to preserve the executable bit when
	// packing the skill into a .tar.gz archive.
	mode: number;
}

export interface Skill {
	name: string;
	description: string;
	files: SkillFile[];
}

export interface SkillCatalog {
	skills: Skill[];
}
