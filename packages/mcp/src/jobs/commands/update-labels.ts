import type { UpdateLabelsArgs, ScheduledUpdateLabelsArgs } from '../types.js';
import type { JobsApiClient } from '../api-client.js';
import { formatJobDetails, formatScheduledJobDetails } from '../formatters.js';
import { toHfJobOutput, toHfScheduledJobOutput, type JobsCommandResult } from '../jobs-output.js';

export async function updateLabelsCommand(
	args: UpdateLabelsArgs,
	client: JobsApiClient,
	token?: string
): Promise<JobsCommandResult> {
	const job = toHfJobOutput(
		await client.updateJobLabels(args.job_id, args.labels, args.namespace),
		undefined,
		token ? [token] : []
	);
	return {
		formatted: `✓ Job labels replaced.\n\n${formatJobDetails([job])}`,
		outcome: { kind: 'job', job },
		totalResults: 1,
		resultsShared: 1,
	};
}

export async function scheduledUpdateLabelsCommand(
	args: ScheduledUpdateLabelsArgs,
	client: JobsApiClient,
	token?: string
): Promise<JobsCommandResult> {
	const job = toHfScheduledJobOutput(
		await client.updateScheduledJobLabels(args.scheduled_job_id, args.labels, args.namespace),
		token ? [token] : []
	);
	return {
		formatted: `✓ Scheduled job labels replaced.\n\n${formatScheduledJobDetails(job)}`,
		outcome: { kind: 'scheduled_job', scheduled_job: job },
		totalResults: 1,
		resultsShared: 1,
	};
}
