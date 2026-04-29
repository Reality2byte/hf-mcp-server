import { createRepo } from '@huggingface/hub';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateRepoTool, formatCreateRepoResult } from './create-repo.js';

vi.mock('@huggingface/hub', () => ({
	createRepo: vi.fn(),
}));

describe('CreateRepoTool', () => {
	beforeEach(() => {
		vi.mocked(createRepo).mockReset();
		vi.mocked(createRepo).mockResolvedValue({
			repoUrl: 'https://huggingface.co/alice/example-model',
			id: '0123456789abcdef01234567',
		});
	});

	it('creates a model repository with client-native repo params', async () => {
		const tool = new CreateRepoTool('token');
		const result = await tool.create({
			name: 'alice/example-model',
			repo_type: 'model',
		});

		expect(createRepo).toHaveBeenCalledWith({
			accessToken: 'token',
			repo: { name: 'alice/example-model', type: 'model' },
			private: undefined,
		});
		expect(result).toEqual({
			url: 'https://huggingface.co/alice/example-model',
			name: 'alice/example-model',
			repoType: 'model',
			id: '0123456789abcdef01234567',
		});
	});

	it('defaults to model repositories', async () => {
		const tool = new CreateRepoTool('token');
		await tool.create({
			name: 'alice/default-model',
		});

		expect(createRepo).toHaveBeenCalledWith({
			accessToken: 'token',
			repo: { name: 'alice/default-model', type: 'model' },
			private: undefined,
		});
	});

	it('creates a dataset repository', async () => {
		const tool = new CreateRepoTool('token');
		await tool.create({
			name: 'alice/example-dataset',
			repo_type: 'dataset',
			private: true,
		});

		expect(createRepo).toHaveBeenCalledWith({
			accessToken: 'token',
			repo: { name: 'alice/example-dataset', type: 'dataset' },
			private: true,
		});
	});

	it('creates a Space repository with sdk', async () => {
		vi.mocked(createRepo).mockResolvedValue({
			repoUrl: 'https://huggingface.co/spaces/alice/demo',
			id: 'abcdefabcdefabcdefabcdef',
		});
		const tool = new CreateRepoTool('token');
		await tool.create({
			name: 'alice/demo',
			repo_type: 'space',
			sdk: 'gradio',
		});

		expect(createRepo).toHaveBeenCalledWith({
			accessToken: 'token',
			repo: { name: 'alice/demo', type: 'space' },
			private: undefined,
			sdk: 'gradio',
		});
	});

	it('requires sdk for Space repositories', async () => {
		const tool = new CreateRepoTool('token');
		await expect(
			tool.create({
				name: 'alice/demo',
				repo_type: 'space',
			})
		).rejects.toThrow('sdk is required when repo_type is space');
		expect(createRepo).not.toHaveBeenCalled();
	});

	it('requires fully-qualified repo names', async () => {
		const tool = new CreateRepoTool('token');
		await expect(
			tool.create({
				name: 'example-model',
				repo_type: 'model',
			})
		).rejects.toThrow("name must be fully qualified in 'namespace/repo-name' format");
		expect(createRepo).not.toHaveBeenCalled();
	});

	it('requires an auth token', async () => {
		const tool = new CreateRepoTool(undefined);
		await expect(
			tool.create({
				name: 'alice/example-model',
				repo_type: 'model',
			})
		).rejects.toThrow('Requires Authentication');
		expect(createRepo).not.toHaveBeenCalled();
	});

	it('formats the created repository result', () => {
		expect(
			formatCreateRepoResult({
				url: 'https://huggingface.co/alice/example-model',
				name: 'alice/example-model',
				repoType: 'model',
				id: '0123456789abcdef01234567',
			})
		).toBe(
			[
				'Repository created.',
				'Name: alice/example-model',
				'Type: model',
				'URL: https://huggingface.co/alice/example-model',
				'ID: 0123456789abcdef01234567',
			].join('\n')
		);
	});
});
