import type { PsArgs } from '../types.js';
import type { JobsApiClient } from '../api-client.js';
import { formatJobsTable } from '../formatters.js';
import { toHfJobOutput, type JobsCommandResult } from '../jobs-output.js';

/**
 * Execute the 'ps' command
 * Lists jobs with optional filtering
 */
export async function psCommand(args: PsArgs, client: JobsApiClient): Promise<JobsCommandResult> {
	// Fetch all jobs from API
	const allJobs = await client.listJobs(args.namespace);

	// Filter jobs
	let jobs = allJobs;

	// Default: show only running jobs unless --all is specified
	if (!args.all) {
		jobs = jobs.filter((job) => job.status.stage === 'RUNNING');
	}

	// Apply status filter if specified
	if (args.status) {
		const statusFilter = args.status.toUpperCase();
		jobs = jobs.filter((job) => job.status.stage.toUpperCase().includes(statusFilter));
	}

	// Format as markdown table
	const table = formatJobsTable(jobs);

	if (jobs.length === 0) {
		return {
			formatted: args.all ? 'No jobs found.' : 'No running jobs found. Use `{"args": {"all": true}}` to show all jobs.',
			outcome: {
				kind: 'jobs',
				jobs: [],
				total_jobs: allJobs.length,
			},
			totalResults: allJobs.length,
			resultsShared: 0,
		};
	}

	return {
		formatted: `**Jobs (${jobs.length} of ${allJobs.length} total):**

${table}`,
		outcome: {
			kind: 'jobs',
			jobs: jobs.map((job) => toHfJobOutput(job)),
			total_jobs: allJobs.length,
		},
		totalResults: allJobs.length,
		resultsShared: jobs.length,
	};
}
