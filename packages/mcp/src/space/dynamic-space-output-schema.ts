import { z } from 'zod';

const jsonRecordSchema = z.record(z.string(), z.json());

const parameterSchema = z.object({
	name: z.string(),
	type: z.string(),
	description: z.string().optional(),
	required: z.boolean(),
	default: z.json().optional(),
	enum: z.array(z.json()).optional(),
	is_file_data: z.boolean().optional(),
	complex_type: z.string().optional(),
});

const dynamicSpaceOutcomeSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('usage'),
		mode: z.enum(['standard', 'dynamic']),
		available_operations: z.array(z.enum(['find', 'discover', 'view_parameters', 'invoke'])),
		instructions: z.string(),
	}),
	z.object({
		kind: z.literal('find_hints'),
		hints: z.array(z.string()),
	}),
	z.object({
		kind: z.literal('find_results'),
		query: z.string(),
		spaces: z.array(
			z.object({
				space_id: z.string(),
				url: z.string(),
				title: z.string().optional(),
				description: z.string().optional(),
				category: z.string().optional(),
				likes: z.number().optional(),
				trending_score: z.number().optional(),
				semantic_relevance: z.number().optional(),
			})
		),
		truncated: z.boolean(),
	}),
	z.object({
		kind: z.literal('discover_results'),
		spaces: z.array(
			z.object({
				space_id: z.string(),
				url: z.string(),
				category: z.string(),
				description: z.string(),
			})
		),
	}),
	z.object({
		kind: z.literal('parameter_schema'),
		space_name: z.string(),
		tool_name: z.string(),
		tool_description: z.string().optional(),
		parameters: z.array(parameterSchema),
	}),
	z.object({
		kind: z.literal('invoke_result'),
		space_name: z.string(),
		warnings: z.array(z.string()),
		is_error: z.boolean(),
		upstream_content: z.array(z.json()),
		upstream_structured_content: jsonRecordSchema.optional(),
		upstream_meta: jsonRecordSchema.optional(),
	}),
	z.object({
		kind: z.literal('error'),
		operation: z.enum(['find', 'discover', 'view_parameters', 'invoke']).optional(),
		code: z.enum([
			'invalid_operation',
			'missing_space_name',
			'missing_parameters',
			'invalid_parameters_json',
			'no_tools',
			'complex_schema',
			'parameter_validation',
			'discover_unconfigured',
			'discover_fetch_failed',
			'invoke_disabled',
			'execution_failed',
		]),
		message: z.string(),
		validation_errors: z.array(z.string()).optional(),
	}),
]);

/**
 * Proposed output contract for `dynamic_space`.
 *
 * Known local operations have typed outcomes. The arbitrary remote result of
 * `invoke` is bounded inside one explicit envelope instead of making the
 * entire output schema permissive.
 */
export const DYNAMIC_SPACE_PROPOSED_OUTPUT_SCHEMA = z.object({
	operation: z.enum(['find', 'discover', 'view_parameters', 'invoke']).optional(),
	outcome: dynamicSpaceOutcomeSchema,
	total_results: z.number().int().nonnegative(),
	results_shared: z.number().int().nonnegative(),
});
