import { describe, expect, it, vi } from 'vitest';
import {
	HF_SANDBOX_TOOL_CONFIG,
	HfSandboxTool,
	formatSandboxHandle,
	parseSandboxHandle,
	type SandboxJobsClient,
	type SandboxRpcClient,
} from '../src/sandbox-tool.js';
import type { JobInfo, JobSpec } from '../src/jobs/types.js';

const TOKEN = 'steady-bridge-abcdefghijklmnopqrstuvwxyz123456';
const HANDLE = `hfsb1:evalstate:6a2bfe87871c005b5352b2d1:${TOKEN}`;

function parseToolJson(text: string): unknown {
	const match = text.match(/^```json\n([\s\S]*)\n```$/);
	if (!match?.[1]) {
		throw new Error(`Expected JSON code block, got: ${text}`);
	}
	return JSON.parse(match[1]) as unknown;
}

function createJobInfo(overrides: Partial<JobInfo> = {}): JobInfo {
	return {
		id: '6a2bfe87871c005b5352b2d1',
		createdAt: '2026-01-01T00:00:00Z',
		dockerImage: 'python:3.12',
		command: ['python', '-u', '-c', 'server'],
		environment: {},
		flavor: 'cpu-basic',
		status: { stage: 'RUNNING', expose_urls: ['https://custom--8000.hf.jobs'] },
		owner: { id: 'user-id', name: 'evalstate', type: 'user' },
		...overrides,
	};
}

function createJobsClient(): SandboxJobsClient {
	return {
		getNamespace: vi.fn(async (namespace?: string) => namespace ?? 'evalstate'),
		runJob: vi.fn(async () => createJobInfo()),
		getJob: vi.fn(async () => createJobInfo()),
		cancelJob: vi.fn(async () => undefined),
	};
}

function createRpcClient(): SandboxRpcClient {
	return {
		health: vi.fn(async () => ({ ok: true })),
		exec: vi.fn(async () => ({ returncode: 0, stdout: '42\n', stderr: '' })),
		write: vi.fn(async () => ({ path: '/sandbox/message.txt', bytes: 17 })),
		read: vi.fn(async () => ({
			path: '/sandbox/message.txt',
			content: 'tada! sandbox tool',
			encoding: 'utf-8',
			bytes: 18,
		})),
	};
}

describe('HfSandboxTool', () => {
	it('exposes the expected tool name', () => {
		expect(HF_SANDBOX_TOOL_CONFIG.name).toBe('hf_sandbox');
	});

	it('parses and formats portable handles', () => {
		const parsed = parseSandboxHandle(HANDLE);
		expect(parsed).toEqual({
			namespace: 'evalstate',
			jobId: '6a2bfe87871c005b5352b2d1',
			sandboxToken: TOKEN,
		});
		expect(formatSandboxHandle(parsed)).toBe(HANDLE);
	});

	it('rejects weak sandbox tokens in handles', () => {
		expect(() => parseSandboxHandle('hfsb1:evalstate:job123:short')).toThrow(/at least 32/);
	});

	it('creates a Jobs-backed sandbox with labels, exposed port, and secret token', async () => {
		const jobsClient = createJobsClient();
		const rpcClient = createRpcClient();
		const tool = new HfSandboxTool('hf-token', true, 'evalstate', jobsClient, rpcClient);

		const result = await tool.execute({
			operation: 'create',
			args: {
				name: 'steady-bridge',
				sandbox_token: TOKEN,
				forward_hf_token: true,
			},
		});

		expect(result.isError).toBeUndefined();
		const payload = parseToolJson(result.formatted) as { handle: string; url: string; job_url: string };
		expect(payload.handle).toBe(HANDLE);
		expect(payload.url).toBe('https://custom--8000.hf.jobs');
		expect(payload.job_url).toBe('https://huggingface.co/jobs/evalstate/6a2bfe87871c005b5352b2d1');

		expect(jobsClient.runJob).toHaveBeenCalledOnce();
		const [jobSpec, namespace] = vi.mocked(jobsClient.runJob).mock.calls[0] as [JobSpec, string];
		expect(namespace).toBe('evalstate');
		expect(jobSpec.expose).toEqual({ ports: [8000] });
		expect(jobSpec.labels).toEqual({ 'hf-sandbox': '', pet: 'steady-bridge' });
		expect(jobSpec.environment).toMatchObject({
			HF_SANDBOX_NAME: 'steady-bridge',
			HF_SANDBOX_HANDLE_VERSION: '1',
			HF_SANDBOX_PORT: '8000',
		});
		expect(jobSpec.secrets).toEqual({
			HF_SANDBOX_TOKEN: TOKEN,
			HF_TOKEN: 'hf-token',
		});
		expect(jobSpec.command[0]).toBe('python');
	});

	it('delegates exec, write, and read to the sandbox RPC client', async () => {
		const jobsClient = createJobsClient();
		const rpcClient = createRpcClient();
		const tool = new HfSandboxTool('hf-token', true, 'evalstate', jobsClient, rpcClient);

		const execResult = await tool.execute({
			operation: 'exec',
			args: { handle: HANDLE, command: ['python', '-c', 'print(42)'] },
		});
		expect(parseToolJson(execResult.formatted)).toEqual({ returncode: 0, stdout: '42\n', stderr: '' });

		await tool.execute({
			operation: 'write',
			args: { handle: HANDLE, path: 'message.txt', content: 'tada! sandbox tool' },
		});
		await tool.execute({
			operation: 'read',
			args: { handle: HANDLE, path: 'message.txt' },
		});

		expect(rpcClient.exec).toHaveBeenCalledWith(
			expect.objectContaining({ jobId: '6a2bfe87871c005b5352b2d1' }),
			'hf-token',
			expect.objectContaining({ command: ['python', '-c', 'print(42)'] })
		);
		expect(rpcClient.write).toHaveBeenCalledOnce();
		expect(rpcClient.read).toHaveBeenCalledOnce();
	});

	it('returns job status plus best-effort sandbox health', async () => {
		const jobsClient = createJobsClient();
		const rpcClient = createRpcClient();
		const tool = new HfSandboxTool('hf-token', true, 'evalstate', jobsClient, rpcClient);

		const result = await tool.execute({ operation: 'status', args: { handle: HANDLE } });

		expect(parseToolJson(result.formatted)).toMatchObject({
			namespace: 'evalstate',
			job_id: '6a2bfe87871c005b5352b2d1',
			status: { stage: 'RUNNING' },
			health: { ok: true },
		});
		expect(jobsClient.getJob).toHaveBeenCalledWith('6a2bfe87871c005b5352b2d1', 'evalstate');
	});

	it('terminates the backing job', async () => {
		const jobsClient = createJobsClient();
		const tool = new HfSandboxTool('hf-token', true, 'evalstate', jobsClient, createRpcClient());

		const result = await tool.execute({ operation: 'terminate', args: { handle: HANDLE } });

		expect(parseToolJson(result.formatted)).toMatchObject({ terminated: true });
		expect(jobsClient.cancelJob).toHaveBeenCalledWith('6a2bfe87871c005b5352b2d1', 'evalstate');
	});

	it('requires authentication', async () => {
		const tool = new HfSandboxTool(undefined, false, 'evalstate', createJobsClient(), createRpcClient());

		const result = await tool.execute({ operation: 'create', args: { name: 'steady-bridge' } });

		expect(result.isError).toBe(true);
		expect(result.formatted).toContain('require authentication');
	});
});
