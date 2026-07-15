import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteFile, uploadFile } from '@huggingface/hub';
import { HF_FS_WRITE_TOOL_CONFIG, HfFsWriteTool, formatHfFsWriteMarkdown } from './hf-fs-write.js';

vi.mock('@huggingface/hub', () => ({
	uploadFile: vi.fn(),
	deleteFile: vi.fn(),
}));

const commitOutput = {
	commit: {
		oid: 'abc123',
		url: 'https://huggingface.co/org/repo/commit/abc123',
	},
	hookOutput: '',
};

describe('HfFsWriteTool', () => {
	beforeEach(() => {
		vi.mocked(uploadFile).mockReset();
		vi.mocked(deleteFile).mockReset();
	});

	it('describes write behavior in config', () => {
		const config = HfFsWriteTool.createToolConfig();

		expect(Object.keys(config.schema.shape)).toEqual(['cmd', 'args', 'content']);
		expect(config.description).toContain('Grammar; each token below is one args array element');
		expect(config.description).toContain('--create-pr');
		expect(config.annotations.readOnlyHint).toBe(false);
		expect(config.annotations.destructiveHint).toBe(true);
	});

	it('writes text content with put', async () => {
		vi.mocked(uploadFile).mockResolvedValue(commitOutput);

		const result = await new HfFsWriteTool('token').run({
			cmd: 'put',
			args: ['hf://models/org/repo/README.md', '--message', 'Update README', '--branch', 'main'],
			content: 'hello',
		});

		const call = vi.mocked(uploadFile).mock.calls[0]?.[0];
		expect(call).toMatchObject({
			accessToken: 'token',
			repo: { type: 'model', name: 'org/repo' },
			commitTitle: 'Update README',
			branch: 'main',
		});
		expect(call?.file).toHaveProperty('path', 'README.md');
		expect(await uploadedBlob(call?.file).text()).toBe('hello');
		expect(result).toEqual({
			uri: 'hf://models/org/repo/README.md',
			op: 'put',
			repo: 'org/repo',
			repo_type: 'model',
			path: 'README.md',
			bytes: 5,
			branch: 'main',
			message: 'Update README',
			commit: commitOutput.commit,
		});
		expect(HF_FS_WRITE_TOOL_CONFIG.outputSchema.parse(result)).toEqual(result);
		expect(formatHfFsWriteMarkdown(result)).toContain('# hf_fs_write put');
	});

	it('writes base64 bytes and uses URI revision as branch', async () => {
		vi.mocked(uploadFile).mockResolvedValue(commitOutput);

		const result = await new HfFsWriteTool('token').run({
			cmd: 'put',
			args: ['hf://datasets/org/repo@feature/data.bin', '--base64'],
			content: 'aGVsbG8=',
		});

		const call = vi.mocked(uploadFile).mock.calls[0]?.[0];
		expect(call).toMatchObject({
			repo: { type: 'dataset', name: 'org/repo' },
			branch: 'feature',
			commitTitle: 'Put data.bin',
		});
		expect(new Uint8Array(await uploadedBlob(call?.file).arrayBuffer())).toEqual(new TextEncoder().encode('hello'));
		expect(result.bytes).toBe(5);
		expect(result.branch).toBe('feature');
	});

	it('removes files with rm', async () => {
		vi.mocked(deleteFile).mockResolvedValue(commitOutput);

		const result = await new HfFsWriteTool('token').run({
			cmd: 'rm',
			args: ['hf://spaces/org/repo/app.py'],
		});

		expect(deleteFile).toHaveBeenCalledWith({
			accessToken: 'token',
			repo: { type: 'space', name: 'org/repo' },
			path: 'app.py',
			commitTitle: 'Remove app.py',
		});
		expect(result).toEqual({
			uri: 'hf://spaces/org/repo/app.py',
			op: 'rm',
			repo: 'org/repo',
			repo_type: 'space',
			path: 'app.py',
			message: 'Remove app.py',
			commit: commitOutput.commit,
		});
	});

	it('supports bucket put and rm without branch or commit output', async () => {
		vi.mocked(uploadFile).mockResolvedValue(undefined);
		vi.mocked(deleteFile).mockResolvedValue(undefined);

		await expect(
			new HfFsWriteTool('token').run({
				cmd: 'put',
				args: ['hf://buckets/org/bucket/path/file.txt'],
				content: '',
			})
		).resolves.toMatchObject({
			op: 'put',
			repo: 'org/bucket',
			repo_type: 'bucket',
			path: 'path/file.txt',
			bytes: 0,
		});

		await expect(
			new HfFsWriteTool('token').run({
				cmd: 'rm',
				args: ['hf://buckets/org/bucket/path/file.txt'],
			})
		).resolves.toMatchObject({
			op: 'rm',
			repo: 'org/bucket',
			repo_type: 'bucket',
			path: 'path/file.txt',
		});
	});

	it('rejects invalid write inputs before calling the Hub', async () => {
		const tool = new HfFsWriteTool('token');

		await expect(tool.run({ cmd: 'put', args: ['hf://models/org/repo/file.txt'] })).rejects.toThrow(
			'put requires content'
		);
		await expect(
			tool.run({ cmd: 'put', args: ['hf://models/org/repo/file.txt', '--base64'], content: 'not base64' })
		).rejects.toThrow('base64 must be valid');
		await expect(tool.run({ cmd: 'rm', args: ['hf://models/org/repo/file.txt'], content: 'a' })).rejects.toThrow(
			'content is only valid with put'
		);
		await expect(tool.run({ cmd: 'rm', args: ['hf://models/org/repo'] })).rejects.toThrow(
			'rm requires a URI that points to a file path'
		);
		await expect(tool.run({ cmd: 'rm', args: ['hf://models/org'] })).rejects.toThrow(
			'rm requires a URI that points to a file path, not a namespace'
		);
		await expect(
			tool.run({
				cmd: 'put',
				args: ['hf://models/org/repo@dev/file.txt', '--branch', 'main'],
				content: 'a',
			})
		).rejects.toThrow("Specify the target branch either with uri '@revision' or with branch");
		await expect(
			tool.run({
				cmd: 'put',
				args: ['hf://buckets/org/bucket/file.txt', '--branch', 'main'],
				content: 'a',
			})
		).rejects.toThrow('branch is not supported for bucket writes');
		await expect(
			tool.run({
				cmd: 'put',
				args: ['hf://buckets/org/bucket/file.txt', '--create-pr'],
				content: 'a',
			})
		).rejects.toThrow('pull requests, descriptions, and parent commits are not supported for bucket writes');
		expect(uploadFile).not.toHaveBeenCalled();
		expect(deleteFile).not.toHaveBeenCalled();
	});

	it('creates a pull request with commit metadata and concurrency protection', async () => {
		vi.mocked(uploadFile).mockResolvedValue({
			...commitOutput,
			pullRequestUrl: 'https://huggingface.co/org/repo/discussions/7',
		});

		const result = await new HfFsWriteTool('token').run({
			cmd: 'put',
			args: [
				'hf://models/org/repo/README.md',
				'--create-pr',
				'--message',
				'Propose README',
				'--description',
				'Why this change is useful',
				'--parent-commit',
				'0123456789abcdef0123456789abcdef01234567',
			],
			content: 'hello',
		});

		expect(uploadFile).toHaveBeenCalledWith(
			expect.objectContaining({
				isPullRequest: true,
				commitTitle: 'Propose README',
				commitDescription: 'Why this change is useful',
				parentCommit: '0123456789abcdef0123456789abcdef01234567',
			})
		);
		expect(result.pull_request_url).toBe('https://huggingface.co/org/repo/discussions/7');
		expect(formatHfFsWriteMarkdown(result)).toContain('Pull request: https://huggingface.co/org/repo/discussions/7');
	});

	it('requires authentication', async () => {
		await expect(
			new HfFsWriteTool().run({
				cmd: 'put',
				args: ['hf://models/org/repo/file.txt'],
				content: 'hello',
			})
		).rejects.toThrow('Requires Authentication');
	});
});

function uploadedBlob(file: Parameters<typeof uploadFile>[0]['file'] | undefined): Blob {
	if (!file || file instanceof URL || !('content' in file) || !(file.content instanceof Blob)) {
		throw new Error('Expected upload file Blob content');
	}
	return file.content;
}
