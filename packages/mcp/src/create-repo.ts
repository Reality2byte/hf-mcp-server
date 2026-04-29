import { createRepo, type RepoType as HubRepoType, type SpaceSdk } from '@huggingface/hub';
import { z } from 'zod';
import { NO_TOKEN_INSTRUCTIONS } from './utilities.js';

const REPO_TYPES = ['model', 'dataset', 'space', 'bucket'] as const satisfies readonly HubRepoType[];
const SPACE_SDKS = ['streamlit', 'gradio', 'docker', 'static'] as const satisfies readonly SpaceSdk[];

export const CREATE_REPO_TOOL_CONFIG = {
	name: 'create_repo',
	description: '',
	schema: z.object({
		name: z.string().min(1).describe("Fully-qualified repository name in 'namespace/repo-name' format."),
		repo_type: z.enum(REPO_TYPES).optional().default('bucket').describe('Repository type. Defaults to bucket.'),
		private: z.boolean().optional().describe('Whether to create the repository as private.'),
		sdk: z.enum(SPACE_SDKS).optional().default('static').describe("SDK type - only required for repo_type='space'."),
	}),
	annotations: {
		title: 'Create Hugging Face Repository',
		destructiveHint: false,
		readOnlyHint: false,
		openWorldHint: true,
	},
} as const;

export type CreateRepoParams = z.input<typeof CREATE_REPO_TOOL_CONFIG.schema>;
type RepoType = (typeof REPO_TYPES)[number];
type SupportedSpaceSdk = (typeof SPACE_SDKS)[number];

function assertExhaustiveUnion<T extends never>(_value?: T): void {
	void _value;
}

assertExhaustiveUnion<Exclude<HubRepoType, RepoType>>();
assertExhaustiveUnion<Exclude<RepoType, HubRepoType>>();
assertExhaustiveUnion<Exclude<SpaceSdk, SupportedSpaceSdk>>();
assertExhaustiveUnion<Exclude<SupportedSpaceSdk, SpaceSdk>>();

export interface CreateRepoResult {
	url: string;
	name: string;
	repoType: RepoType;
	id: string;
}

export class CreateRepoTool {
	constructor(private readonly hfToken?: string) {}

	static createToolConfig(): Omit<typeof CREATE_REPO_TOOL_CONFIG, 'description'> & { description: string } {
		return {
			...CREATE_REPO_TOOL_CONFIG,
			description: 'Create a Hugging Face model, dataset, space, or bucket repository.',
		};
	}

	async create(params: CreateRepoParams): Promise<CreateRepoResult> {
		if (!this.hfToken) throw new Error(NO_TOKEN_INSTRUCTIONS);

		const repoType = params.repo_type ?? 'model';
		validateParams(params, repoType);

		const result = await createRepo({
			accessToken: this.hfToken,
			repo: {
				name: params.name,
				type: repoType,
			},
			private: params.private,
			...(repoType === 'space' ? { sdk: params.sdk } : {}),
		});

		return {
			url: result.repoUrl,
			name: params.name,
			repoType,
			id: result.id,
		};
	}
}

function validateParams(params: CreateRepoParams, repoType: RepoType): void {
	if (!isFullyQualifiedRepoName(params.name)) {
		throw new Error("name must be fully qualified in 'namespace/repo-name' format.");
	}

	if (repoType === 'space' && !params.sdk) {
		throw new Error('sdk is required when repo_type is space.');
	}
}

function isFullyQualifiedRepoName(name: string): boolean {
	const parts = name.split('/');
	return parts.length === 2 && parts.every((part) => part.length > 0);
}

export const formatCreateRepoResult = (result: CreateRepoResult): string => {
	return [
		'Repository created.',
		`Name: ${result.name}`,
		`Type: ${result.repoType}`,
		`URL: ${result.url}`,
		`ID: ${result.id}`,
	].join('\n');
};
