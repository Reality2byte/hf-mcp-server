import { z } from 'zod';

const jsonRecordSchema = z.record(z.string(), z.json());

const modelMatchSchema = z.object({
	repo_type: z.literal('model'),
	overview: jsonRecordSchema,
});

const datasetStructureSchema = z.object({
	configs: z.array(jsonRecordSchema),
	splits: z.array(jsonRecordSchema),
	parquet_files: z.array(jsonRecordSchema),
	features: z.array(jsonRecordSchema),
	pending: z.array(z.json()).optional(),
	failed: z.array(z.json()).optional(),
	partial: z.boolean(),
	warnings: z.array(z.string()).optional(),
});

const datasetPreviewSchema = z.object({
	config: z.string(),
	split: z.string(),
	offset: z.number().int().nonnegative(),
	rows: z.array(
		z.object({
			row_index: z.number().int().nonnegative(),
			row: jsonRecordSchema,
			truncated_cells: z.array(z.string()),
		})
	),
	total_rows: z.number().int().nonnegative().optional(),
	partial: z.boolean(),
	warnings: z.array(z.string()).optional(),
});

const datasetMatchSchema = z.object({
	repo_type: z.literal('dataset'),
	overview: jsonRecordSchema.optional(),
	structure: datasetStructureSchema.optional(),
	preview: datasetPreviewSchema.optional(),
});

const spaceMatchSchema = z.object({
	repo_type: z.literal('space'),
	overview: z.object({
		name: z.string(),
		url: z.string(),
		author: z.string().optional(),
		sdk: z.string().optional(),
		likes: z.number(),
		updated_at: z.string(),
		tags: z.array(z.string()).optional(),
		runtime: z.json().optional(),
		subdomain: z.string().optional(),
		sha: z.string().optional(),
	}),
});

const repoMatchSchema = z.discriminatedUnion('repo_type', [modelMatchSchema, datasetMatchSchema, spaceMatchSchema]);

const repositoryResultSchema = z.discriminatedUnion('status', [
	z.object({
		status: z.literal('ok'),
		repo_id: z.string(),
		matches: z.array(repoMatchSchema).min(1),
	}),
	z.object({
		status: z.literal('operation_mismatch'),
		repo_id: z.string(),
		requested_operations: z.array(z.enum(['overview', 'dataset_structure', 'dataset_preview'])),
		message: z.string(),
	}),
	z.object({
		status: z.literal('error'),
		repo_id: z.string(),
		error: z.string(),
	}),
]);

/**
 * Proposed output contract for `hub_repo_details`.
 *
 * Auto-detection may find more than one repository type for a single ID, so
 * each successful repository result contains `matches` rather than one type.
 * Flexible Hub/Dataset Viewer payloads are confined to named JSON leaves.
 */
export const HUB_REPO_DETAILS_PROPOSED_OUTPUT_SCHEMA = z.object({
	requested_operations: z.array(z.enum(['overview', 'dataset_structure', 'dataset_preview'])),
	repositories: z.array(repositoryResultSchema),
	total_results: z.number().int().nonnegative(),
	results_shared: z.number().int().nonnegative(),
});
