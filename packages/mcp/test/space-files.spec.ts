import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SpaceFilesTool, SPACE_FILES_TOOL_CONFIG } from '../src/space-files.js';
import * as hub from '@huggingface/hub';

// Mock the @huggingface/hub module
vi.mock('@huggingface/hub', () => ({
	spaceInfo: vi.fn(),
	listFiles: vi.fn(),
}));

describe('SpaceFilesTool', () => {
	let tool: SpaceFilesTool;

	beforeEach(() => {
		tool = new SpaceFilesTool(undefined, 'testuser');
		vi.clearAllMocks();
	});

	describe('getSpaceFilesWithUrls', () => {
		it('should list files for a static space with subdomain', async () => {
			// Mock space info response
			vi.mocked(hub.spaceInfo).mockResolvedValue({
				id: 'evalstate/filedrop',
				sdk: 'static',
				subdomain: 'evalstate-filedrop',
			} as any);

			// Mock file listing
			const mockFiles = [
				{
					type: 'file',
					path: 'index.html',
					size: 1024,
					lastCommit: { date: '2024-01-01T00:00:00Z' },
					lfs: null,
				},
				{
					type: 'file',
					path: 'css/style.css',
					size: 2048,
					lastCommit: { date: '2024-01-02T00:00:00Z' },
					lfs: null,
				},
			];

			// Create async generator for listFiles
			async function* mockListFiles() {
				for (const file of mockFiles) {
					yield file;
				}
			}

			vi.mocked(hub.listFiles).mockReturnValue(mockListFiles() as any);

			const files = await tool.getSpaceFilesWithUrls('evalstate/filedrop');

			expect(files).toHaveLength(2);
			expect(files[0]).toMatchObject({
				path: 'css/style.css',
				size: 2048,
				type: 'file',
				url: 'https://evalstate-filedrop.static.hf.space/css/style.css',
				sizeFormatted: '2.0 KB',
				lfs: false,
			});
			expect(files[1]).toMatchObject({
				path: 'index.html',
				size: 1024,
				type: 'file',
				url: 'https://evalstate-filedrop.static.hf.space/index.html',
				sizeFormatted: '1.0 KB',
				lfs: false,
			});
		});

		it('should handle spaces without subdomain', async () => {
			// Mock space info response without subdomain
			vi.mocked(hub.spaceInfo).mockResolvedValue({
				id: 'test/space',
				sdk: 'static',
			} as any);

			// Mock file listing
			async function* mockListFiles() {
				yield {
					type: 'file',
					path: 'index.html',
					size: 512,
					lastCommit: null,
					lfs: null,
				};
			}

			vi.mocked(hub.listFiles).mockReturnValue(mockListFiles() as any);

			const files = await tool.getSpaceFilesWithUrls('test/space');

			expect(files).toHaveLength(1);
			expect(files[0].url).toBe('https://huggingface.co/spaces/test/space/resolve/main/index.html');
		});

		it('should throw error for non-static spaces', async () => {
			// Mock space info response with non-static SDK
			vi.mocked(hub.spaceInfo).mockResolvedValue({
				id: 'test/gradio-app',
				sdk: 'gradio',
			} as any);

			await expect(tool.getSpaceFilesWithUrls('test/gradio-app')).rejects.toThrow(
				'Space "test/gradio-app" is not a static space (found: gradio). This tool only works with static HTML/CSS/JS spaces.'
			);
		});
	});

	describe('listFiles', () => {
		beforeEach(() => {
			// Mock a successful static space
			vi.mocked(hub.spaceInfo).mockResolvedValue({
				id: 'evalstate/filedrop',
				sdk: 'static',
				subdomain: 'evalstate-filedrop',
			} as any);

			// Mock file listing
			async function* mockListFiles() {
				yield {
					type: 'file',
					path: 'index.html',
					size: 1024,
					lastCommit: { date: '2024-01-01T00:00:00Z' },
					lfs: null,
				};
				yield {
					type: 'file',
					path: 'js/app.js',
					size: 4096,
					lastCommit: { date: '2024-01-02T00:00:00Z' },
					lfs: null,
				};
			}

			vi.mocked(hub.listFiles).mockReturnValue(mockListFiles() as any);
		});

		it('should generate detailed markdown by default', async () => {
			const result = await tool.listFiles({ spaceName: 'evalstate/filedrop', format: 'detailed' });

			expect(result).toContain('# Files in Space: evalstate/filedrop');
			expect(result).toContain('**Total Files**: 2');
			expect(result).toContain('**Total Size**: 5.1 KB');
			expect(result).toContain('| File Path | Size | Type | Last Modified | URL |');
			expect(result).toContain('🌐 index.html');
			expect(result).toContain('📜 app.js');
			expect(result).toContain('## Direct Access Examples');
		});

		it('should generate simple markdown when requested', async () => {
			const result = await tool.listFiles({ spaceName: 'evalstate/filedrop', format: 'simple' });

			expect(result).toContain('# Files in evalstate/filedrop');
			expect(result).toContain('| File Name | Path | Size | URL |');
			expect(result).toContain('🌐 index.html');
			expect(result).toContain('📜 app.js');
			expect(result).not.toContain('## Direct Access Examples');
		});
	});

	describe('SPACE_FILES_TOOL_CONFIG', () => {
		it('should have correct base configuration', () => {
			expect(SPACE_FILES_TOOL_CONFIG.name).toBe('space_files');
			expect(SPACE_FILES_TOOL_CONFIG.annotations.readOnlyHint).toBe(true);
			expect(SPACE_FILES_TOOL_CONFIG.annotations.destructiveHint).toBe(false);
		});

		it('should validate schema correctly', () => {
			const schema = SPACE_FILES_TOOL_CONFIG.schema;

			// Test default values
			const defaultResult = schema.parse({});
			expect(defaultResult).toEqual({
				format: 'detailed',
			});

			// Test custom values
			const customResult = schema.parse({
				spaceName: 'user/space',
				format: 'simple',
			});
			expect(customResult).toEqual({
				spaceName: 'user/space',
				format: 'simple',
			});

			// Test invalid format
			expect(() => schema.parse({ format: 'invalid' })).toThrow();
		});
	});

	describe('createToolConfig', () => {
		it('should create config with username', () => {
			const config = SpaceFilesTool.createToolConfig('testuser');
			expect(config.name).toBe('space_files');
			expect(config.description).toContain('testuser/filedrop');
		});

		it('should create config without username', () => {
			const config = SpaceFilesTool.createToolConfig();
			expect(config.name).toBe('space_files');
			expect(config.description).toContain('Requires Authentication');
		});
	});

	describe('default spaceName behavior', () => {
		it('should use username/filedrop as default when no spaceName provided', async () => {
			// Mock space info response
			vi.mocked(hub.spaceInfo).mockResolvedValue({
				id: 'testuser/filedrop',
				sdk: 'static',
				subdomain: 'testuser-filedrop',
			} as any);

			// Mock empty file listing
			async function* mockListFiles() {
				// Empty generator
			}
			vi.mocked(hub.listFiles).mockReturnValue(mockListFiles() as any);

			const result = await tool.listFiles({ format: 'simple' });
			
			expect(result).toContain('# Files in testuser/filedrop');
			expect(vi.mocked(hub.spaceInfo)).toHaveBeenCalledWith(
				expect.objectContaining({
					name: 'testuser/filedrop',
				})
			);
		});
	});
});