import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as hub from '@huggingface/hub';
import type { ListFileEntry } from '@huggingface/hub';
import { LIST_FILES_TOOL_CONFIG, ListFilesTool, GRADIO_FILES_TOOL_CONFIG } from '../src/gradio-files.js';

vi.mock('@huggingface/hub', () => ({
	listFiles: vi.fn(),
}));

async function* listFileEntries(entries: ListFileEntry[]): AsyncGenerator<ListFileEntry> {
	for (const entry of entries) {
		yield entry;
	}
}

function mockListFiles(entries: ListFileEntry[]): void {
	vi.mocked(hub.listFiles).mockReturnValue(listFileEntries(entries));
}

describe('ListFilesTool', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('lists bucket files recursively and encodes nested bucket URLs', async () => {
		mockListFiles([
			{ type: 'directory', path: 'images', size: 0 },
			{ type: 'file', path: 'images/cat 1.png', size: 2048, uploadedAt: '2026-04-27T00:00:00Z' },
		]);

		const tool = new ListFilesTool('hf_token', { kind: 'bucket', id: 'alice/mcp' });
		const files = await tool.getFiles();

		expect(hub.listFiles).toHaveBeenCalledWith({
			repo: { type: 'bucket', name: 'alice/mcp' },
			recursive: true,
			expand: true,
			accessToken: 'hf_token',
		});
		expect(files).toEqual([
			expect.objectContaining({
				path: 'images/cat 1.png',
				url: 'https://huggingface.co/buckets/alice/mcp/resolve/images/cat%201.png',
				lastModified: '2026-04-27T00:00:00Z',
				source: 'bucket',
			}),
		]);
	});

	it('keeps legacy dataset fallback behavior and excludes git metadata files', async () => {
		mockListFiles([
			{ type: 'file', path: '.gitattributes', size: 100 },
			{ type: 'file', path: '.gitignore', size: 100 },
			{
				type: 'file',
				path: 'cat.png',
				size: 1024,
				lastCommit: { date: '2026-04-27T00:00:00Z', id: '1', title: 'add' },
			},
		]);

		const tool = new ListFilesTool('hf_token', { kind: 'dataset', id: 'alice/gradio-files' });
		const files = await tool.getFiles();

		expect(hub.listFiles).toHaveBeenCalledWith({
			repo: { type: 'dataset', name: 'alice/gradio-files' },
			recursive: false,
			expand: true,
			accessToken: 'hf_token',
		});
		expect(files).toHaveLength(1);
		expect(files[0]).toMatchObject({
			path: 'cat.png',
			url: 'https://huggingface.co/datasets/alice/gradio-files/resolve/main/cat.png',
			source: 'dataset',
		});
	});

	it('filters image, audio, and text files in markdown', async () => {
		mockListFiles([
			{ type: 'file', path: 'cat.png', size: 1024 },
			{ type: 'file', path: 'sound.wav', size: 1024 },
			{ type: 'file', path: 'notes.json', size: 1024 },
		]);

		const tool = new ListFilesTool('hf_token', { kind: 'bucket', id: 'alice/mcp' });
		const markdown = await tool.generateDetailedMarkdown('text');

		expect(markdown).toContain('notes.json');
		expect(markdown).not.toContain('cat.png');
		expect(markdown).not.toContain('sound.wav');
	});

	it('identifies bucket source in markdown', async () => {
		mockListFiles([{ type: 'file', path: 'hello.txt', size: 5 }]);

		const tool = new ListFilesTool('hf_token', { kind: 'bucket', id: 'alice/mcp' });
		const markdown = await tool.generateDetailedMarkdown();

		expect(markdown).toContain('# Available files in bucket: alice/mcp');
		expect(markdown).toContain('**Source:** Hugging Face Bucket');
		expect(markdown).toContain('private bucket URLs require authorization');
	});

	it('identifies dataset fallback source in markdown', async () => {
		mockListFiles([{ type: 'file', path: 'hello.txt', size: 5 }]);

		const tool = new ListFilesTool('hf_token', { kind: 'dataset', id: 'alice/gradio-files' });
		const markdown = await tool.generateDetailedMarkdown();

		expect(markdown).toContain('# Available files in dataset: alice/gradio-files');
		expect(markdown).toContain('**Source:** Hugging Face Dataset fallback');
		expect(markdown).not.toContain('private bucket URLs require authorization');
	});

	it('exposes list_files while keeping gradio_files compatibility config', () => {
		expect(LIST_FILES_TOOL_CONFIG.name).toBe('list_files');
		expect(LIST_FILES_TOOL_CONFIG.annotations.readOnlyHint).toBe(true);
		expect(GRADIO_FILES_TOOL_CONFIG.name).toBe('gradio_files');
	});
});
