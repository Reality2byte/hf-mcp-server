import { z } from 'zod';

const repoSearchCriteriaSchema = z.object({
	query: z.string().optional(),
	author: z.string().optional(),
	filters: z.array(z.string()).optional(),
	sort: z.enum(['trendingScore', 'downloads', 'likes', 'createdAt', 'lastModified']).optional(),
	repo_types: z.array(z.enum(['model', 'dataset', 'space'])),
	limit_per_type: z.number().int().positive(),
});

const commonRepoSchema = z.object({
	id: z.string(),
	url: z.string(),
	author: z.string().nullable().optional(),
	likes: z.number().optional(),
	downloads: z.number().optional(),
	trending_score: z.number().optional(),
	private: z.boolean().optional(),
	tags: z.array(z.string()).optional(),
	created_at: z.string().optional(),
	last_modified: z.string().nullable().optional(),
});

const modelRepoSchema = commonRepoSchema.extend({
	repo_type: z.literal('model'),
	pipeline_tag: z.string().optional(),
	library_name: z.string().optional(),
});

const datasetRepoSchema = commonRepoSchema.extend({
	repo_type: z.literal('dataset'),
	description: z.string().optional(),
	gated: z.boolean().optional(),
});

const spaceRepoSchema = commonRepoSchema.extend({
	repo_type: z.literal('space'),
	title: z.string().nullable().optional(),
	emoji: z.string().nullable().optional(),
	sdk: z.string().optional(),
	short_description: z.string().optional(),
	ai_short_description: z.string().optional(),
	disabled: z.boolean().nullable().optional(),
});

const repoSearchGroupSchema = z.discriminatedUnion('repo_type', [
	z.object({
		repo_type: z.literal('model'),
		total_results: z.number().int().nonnegative(),
		results: z.array(modelRepoSchema),
	}),
	z.object({
		repo_type: z.literal('dataset'),
		total_results: z.number().int().nonnegative(),
		results: z.array(datasetRepoSchema),
	}),
	z.object({
		repo_type: z.literal('space'),
		total_results: z.number().int().nonnegative(),
		results: z.array(spaceRepoSchema),
	}),
]);

/**
 * Proposed output contract for `hub_repo_search`.
 *
 * The eventual implementation should build this canonical data first and
 * render the existing Markdown from `groups`. Only records included in the
 * Markdown output should be included in `groups[*].results`.
 */
export const HUB_REPO_SEARCH_PROPOSED_OUTPUT_SCHEMA = z.object({
	criteria: repoSearchCriteriaSchema,
	groups: z.array(repoSearchGroupSchema),
	total_results: z.number().int().nonnegative(),
	results_shared: z.number().int().nonnegative(),
	truncated: z.boolean(),
	truncation_message: z.string().optional(),
});
