import type { ToolResult } from '../types/tool-result.js';
import {
	HF_JOBS_OUTPUT_SCHEMA,
	type HfJobOutput,
	type HfJobsOperation,
	type HfJobsOutcome,
	type HfJobsOutput,
	type HfScheduledJobOutput,
} from './hf-jobs-output-schema.js';
import type { JobInfo, JobOwner, JobSpec, ScheduledJobInfo } from './types.js';

export interface JobsCommandResult {
	formatted: string;
	outcome: HfJobsOutcome;
	totalResults: number;
	resultsShared: number;
	isError?: boolean;
}

export interface HfJobsToolResult extends ToolResult {
	structuredContent: HfJobsOutput;
}

/**
 * The Jobs API's owner/createdBy objects are not schema-stable (e.g. extra
 * profile fields, or a missing `type`). Pick only the fields the output
 * schema promises instead of spreading the raw API object.
 */
function normalizeOwner(owner: JobOwner): { id: string; name: string; type?: 'user' | 'org' } {
	return {
		id: owner.id,
		name: owner.name,
		...(owner.type === 'user' || owner.type === 'org' ? { type: owner.type } : {}),
	};
}

export function toHfJobOutput(
	job: JobInfo,
	fallbackUrl?: string,
	additionalSensitiveValues: readonly string[] = []
): HfJobOutput {
	const sensitiveValues = collectSensitiveValues(job, additionalSensitiveValues);
	const redact = (value: string): string => redactSensitiveText(value, sensitiveValues);
	return {
		id: job.id,
		...(job.url || fallbackUrl ? { url: redact(job.url ?? fallbackUrl ?? '') } : {}),
		...(job.endpoint ? { endpoint: redact(job.endpoint) } : {}),
		created_at: job.createdAt,
		...(job.finishedAt ? { finished_at: job.finishedAt } : {}),
		...(job.dockerImage ? { docker_image: redact(job.dockerImage) } : {}),
		...(job.spaceId ? { space_id: redact(job.spaceId) } : {}),
		...(job.command ? { command: job.command.map(redact) } : {}),
		...(job.arguments ? { arguments: job.arguments.map(redact) } : {}),
		environment_variable_names: Object.keys(job.environment ?? {}).sort(),
		secret_names: Object.keys(job.secrets ?? {}).sort(),
		flavor: job.flavor,
		status: {
			stage: job.status.stage,
			...(job.status.message !== undefined
				? { message: job.status.message === null ? null : redact(job.status.message) }
				: {}),
			...(job.status.expose_urls ? { expose_urls: job.status.expose_urls.map(redact) } : {}),
		},
		owner: normalizeOwner(job.owner),
		...(job.createdBy ? { created_by: normalizeOwner(job.createdBy) } : {}),
		...(job.tags ? { tags: job.tags.map(redact) } : {}),
		...(job.labels
			? { labels: Object.fromEntries(Object.entries(job.labels).map(([key, value]) => [key, redact(value)])) }
			: {}),
		...(job.timeout !== undefined ? { timeout_seconds: job.timeout } : {}),
	};
}

export function toHfScheduledJobOutput(
	job: ScheduledJobInfo,
	additionalSensitiveValues: readonly string[] = []
): HfScheduledJobOutput {
	const sensitiveValues = collectSensitiveValues(job.jobSpec, additionalSensitiveValues);
	const redact = (value: string): string => redactSensitiveText(value, sensitiveValues);
	return {
		id: job.id,
		schedule: job.schedule,
		suspended: job.suspend,
		...(job.lastRun ? { last_run: job.lastRun } : {}),
		...(job.nextRun ? { next_run: job.nextRun } : {}),
		owner: normalizeOwner(job.owner),
		created_at: job.createdAt,
		job_spec: {
			...(job.jobSpec.dockerImage ? { docker_image: redact(job.jobSpec.dockerImage) } : {}),
			...(job.jobSpec.spaceId ? { space_id: redact(job.jobSpec.spaceId) } : {}),
			command: job.jobSpec.command.map(redact),
			...(job.jobSpec.arguments ? { arguments: job.jobSpec.arguments.map(redact) } : {}),
			environment_variable_names: Object.keys(job.jobSpec.environment ?? {}).sort(),
			secret_names: Object.keys(job.jobSpec.secrets ?? {}).sort(),
			flavor: job.jobSpec.flavor,
			...(job.jobSpec.timeoutSeconds !== undefined ? { timeout_seconds: job.jobSpec.timeoutSeconds } : {}),
			...(job.jobSpec.volumes
				? {
						volumes: job.jobSpec.volumes.map((volume) => ({
							type: volume.type,
							source: volume.source,
							mount_path: volume.mountPath,
							...(volume.revision ? { revision: volume.revision } : {}),
							...(volume.readOnly !== undefined ? { read_only: volume.readOnly } : {}),
							...(volume.path ? { path: volume.path } : {}),
						})),
					}
				: {}),
			...(job.jobSpec.labels
				? {
						labels: Object.fromEntries(Object.entries(job.jobSpec.labels).map(([key, value]) => [key, redact(value)])),
					}
				: {}),
			...(job.jobSpec.expose ? { exposed_ports: job.jobSpec.expose.ports } : {}),
		},
	};
}

export function collectSensitiveValues(
	source: Pick<JobInfo, 'environment' | 'secrets'> | Pick<JobSpec, 'environment' | 'secrets'>,
	additionalValues: readonly (string | undefined)[] = []
): string[] {
	return [
		...Object.values(source.environment ?? {}),
		...Object.values(source.secrets ?? {}).filter((value): value is string => typeof value === 'string'),
		...additionalValues.filter((value): value is string => typeof value === 'string'),
	]
		.filter((value) => value.length > 0)
		.sort((left, right) => right.length - left.length);
}

export function redactSensitiveText(text: string, sensitiveValues: readonly string[]): string {
	return sensitiveValues.reduce((redacted, value) => redacted.split(value).join('<redacted>'), text);
}

export function createHfJobsToolResult(
	operation: HfJobsOperation | undefined,
	result: JobsCommandResult
): HfJobsToolResult {
	const structuredContent = HF_JOBS_OUTPUT_SCHEMA.parse({
		...(operation ? { operation } : {}),
		outcome: result.outcome,
		total_results: result.totalResults,
		results_shared: result.resultsShared,
	});

	return {
		formatted: result.formatted,
		totalResults: result.totalResults,
		resultsShared: result.resultsShared,
		structuredContent,
		...(result.isError ? { isError: true } : {}),
	};
}
