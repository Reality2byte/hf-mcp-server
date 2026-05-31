export type SkillResourceType = 'skill-md' | 'archive';

export interface SkillResource {
	name: string;
	type: SkillResourceType;
	description: string;
	url: string;
	digest?: string;
	absPath: string;
	mimeType: string;
	isText: boolean;
}

export interface SkillCompatibilityFile {
	resourceName: string;
	url: string;
	absPath: string;
	mimeType: string;
	isText: boolean;
}

export interface SkillCatalog {
	indexPath: string;
	indexText: string;
	skills: SkillResource[];
	compatibilityFiles: SkillCompatibilityFile[];
}
