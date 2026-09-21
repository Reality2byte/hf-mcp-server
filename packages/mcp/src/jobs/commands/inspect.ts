import type { InspectArgs, CancelArgs } from '../types.js';
import type { JobsApiClient } from '../api-client.js';
import { formatJobDetails } from '../formatters.js';
import { toHfJobOutput, type JobsCommandResult } from '../jobs-output.js';

/**
 * Execute the 'inspect' command
 * Gets detailed information about one or more jobs
 */
export async function inspectCommand(args: InspectArgs, client: JobsApiClient): Promise<JobsCommandResult> {
	const jobIds = Array.isArray(args.job_id) ? args.job_id : [args.job_id];

	const inspections = await Promise.all(
		jobIds.map(async (jobId) => {
			try {
				const job = await client.getJob(jobId, args.namespace);
				return {
					job_id: jobId,
					status: 'success' as const,
					job: toHfJobOutput(job),
				};
			} catch (error) {
				return {
					job_id: jobId,
					status: 'error' as const,
					message: `Failed to fetch job ${jobId}: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		})
	);
	const successfulJobs = inspections.flatMap((inspection) => (inspection.status === 'success' ? [inspection.job] : []));
	const errors = inspections.flatMap((inspection) =>
		inspection.status === 'error' ? [`- ${inspection.message}`] : []
	);

	const sections: string[] = [];
	if (successfulJobs.length > 0) {
		sections.push(
			`**Job Details** (${successfulJobs.length} job${successfulJobs.length > 1 ? 's' : ''}):\n\n${formatJobDetails(successfulJobs)}`
		);
	}
	if (errors.length > 0) {
		sections.push(`**Errors:**\n${errors.join('\n')}`);
	}

	return {
		formatted: sections.join('\n\n'),
		outcome: {
			kind: 'inspections',
			requested_job_ids: jobIds,
			inspections,
		},
		totalResults: jobIds.length,
		resultsShared: successfulJobs.length,
		...(successfulJobs.length === 0 ? { isError: true } : {}),
	};
}

/**
 * Execute the 'cancel' command
 * Cancels a running job
 */
export async function cancelCommand(args: CancelArgs, client: JobsApiClient): Promise<JobsCommandResult> {
	await client.cancelJob(args.job_id, args.namespace);

	const message = `✓ Job ${args.job_id} has been cancelled.

To verify, call this tool with \`{"operation": "inspect", "args": {"job_id": "${args.job_id}"}}\``;
	return {
		formatted: message,
		outcome: {
			kind: 'acknowledgement',
			resource_id: args.job_id,
			action: 'canceled',
			message,
		},
		totalResults: 1,
		resultsShared: 1,
	};
}
