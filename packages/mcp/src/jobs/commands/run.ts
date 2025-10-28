import type { RunArgs, UvArgs } from '../types.js';
import type { JobsApiClient } from '../api-client.js';
import { createJobSpec } from './utils.js';
import { fetchJobLogs } from '../sse-handler.js';
import { resolveUvCommand, UV_DEFAULT_IMAGE } from './uv-utils.js';

/**
 * Execute the 'run' command
 * Creates and runs a job, optionally waiting for logs
 */
export async function runCommand(args: RunArgs, client: JobsApiClient, token?: string): Promise<string> {
	// Create job spec from args
	const jobSpec = createJobSpec({
		image: args.image,
		command: args.command,
		flavor: args.flavor,
		env: args.env,
		secrets: args.secrets,
		timeout: args.timeout,
		hfToken: token,
	});

	// Submit job
	const job = await client.runJob(jobSpec, args.namespace);

	const jobUrl = `https://huggingface.co/jobs/${job.owner.name}/${job.id}`;

	// If detached, return immediately
	if (args.detach) {
		return `Job started successfully!

**Job ID:** ${job.id}
**Status:** ${job.status.stage}
**View at:** ${jobUrl}

To check logs: \`hf_jobs("logs", {"job_id": "${job.id}"})\`
To inspect: \`hf_jobs("inspect", {"job_id": "${job.id}"})\``;
	}

	// Not detached - fetch logs
	const logsUrl = client.getLogsUrl(job.id, job.owner.name);
	const logResult = await fetchJobLogs(logsUrl, { token, maxDuration: 10000, maxLines: 20 });

	let response = `Job started: ${job.id}\n\n`;

	if (logResult.logs.length > 0) {
		response += '**Logs (last 20 lines):**\n```\n';
		response += logResult.logs.join('\n');
		response += '\n```\n\n';
	}

	if (logResult.finished) {
		response += `Job finished. Full details: ${jobUrl}`;
	} else if (logResult.truncated) {
		response += `Log collection stopped after 10s. Job may still be running.\n`;
		response += `View full logs: ${jobUrl}`;
	}

	return response;
}

/**
 * Execute the 'uv' command
 * Creates and runs a UV-based Python job
 */
export async function uvCommand(args: UvArgs, client: JobsApiClient, token?: string): Promise<string> {
	// UV jobs use a standard UV image unless overridden
	const image = UV_DEFAULT_IMAGE;

	// Detect script source and build command
	const command = resolveUvCommand(args);

	// Convert to run args
	const runArgs: RunArgs = {
		image,
		command,
		flavor: args.flavor,
		env: args.env,
		secrets: args.secrets,
		timeout: args.timeout,
		detach: args.detach,
		namespace: args.namespace,
	};

	return runCommand(runArgs, client, token);
}
