import { z } from 'zod';
import { listFiles } from '@huggingface/hub';
import { formatBytes, escapeMarkdown } from './utilities.js';
import { HfApiError } from './hf-api-call.js';
import { explain } from './error-messages.js';
import { getFileIcon } from './file-icons.js';

export type FileTypeFilter = 'all' | 'image' | 'audio' | 'text';

export type FileListingSource =
	| {
			kind: 'bucket';
			id: string;
	  }
	| {
			kind: 'dataset';
			id: string;
	  };

interface FileWithUrl {
	path: string;
	size: number;
	type: 'file' | 'directory' | 'unknown';
	url: string;
	sizeFormatted: string;
	lastModified?: string;
	lfs: boolean;
	source: FileListingSource['kind'];
}

// File type detection helpers
const IMAGE_EXTENSIONS = new Set([
	'.jpg',
	'.jpeg',
	'.png',
	'.gif',
	'.bmp',
	'.tiff',
	'.tif',
	'.webp',
	'.svg',
	'.ico',
	'.heic',
	'.heif',
]);

const AUDIO_EXTENSIONS = new Set([
	'.mp3',
	'.wav',
	'.flac',
	'.aac',
	'.ogg',
	'.m4a',
	'.wma',
	'.opus',
	'.aiff',
	'.au',
	'.ra',
]);

const TEXT_EXTENSIONS = new Set([
	'.txt',
	'.md',
	'.json',
	'.xml',
	'.csv',
	'.tsv',
	'.yaml',
	'.yml',
	'.html',
	'.css',
	'.js',
	'.py',
]);

function getFileExtension(path: string): string {
	const lastDot = path.lastIndexOf('.');
	return lastDot === -1 ? '' : path.substring(lastDot).toLowerCase();
}

function isImageFile(path: string): boolean {
	return IMAGE_EXTENSIONS.has(getFileExtension(path));
}

function isAudioFile(path: string): boolean {
	return AUDIO_EXTENSIONS.has(getFileExtension(path));
}

function isTextFile(path: string): boolean {
	return TEXT_EXTENSIONS.has(getFileExtension(path));
}

function matchesFileType(file: FileWithUrl, fileType: FileTypeFilter): boolean {
	switch (fileType) {
		case 'all':
			return true;
		case 'image':
			return isImageFile(file.path);
		case 'audio':
			return isAudioFile(file.path);
		case 'text':
			return isTextFile(file.path);
		default:
			return true;
	}
}

const FILE_TYPE_SCHEMA = z.enum(['all', 'image', 'audio', 'text']).optional().default('all').describe('Filter by type');

export const LIST_FILES_TOOL_CONFIG = {
	name: 'gradio_files',
	description:
		'List files available to use as Gradio File/Image/Audio inputs. Prefer these URLs when a Space asks for a file input and the user has not provided an explicit URL.',
	schema: z.object({
		fileType: FILE_TYPE_SCHEMA,
	}),
	annotations: {
		title: 'Available Input Files',
		destructiveHint: false,
		readOnlyHint: true,
		openWorldHint: true,
	},
} as const;

export type ListFilesParams = z.infer<typeof LIST_FILES_TOOL_CONFIG.schema>;

/**
 * Service for listing files from a Hugging Face Bucket or the legacy gradio-files dataset.
 */
export class ListFilesTool {
	private readonly accessToken: string;
	private readonly source: FileListingSource;

	constructor(hfToken: string, source: FileListingSource) {
		this.accessToken = hfToken;
		this.source = source;
	}

	/**
	 * Get all files with stable Hub URLs.
	 */
	async getFiles(): Promise<FileWithUrl[]> {
		try {
			const files: FileWithUrl[] = [];

			for await (const file of listFiles({
				repo: { type: this.source.kind, name: this.source.id },
				recursive: this.source.kind === 'bucket',
				expand: true,
				accessToken: this.accessToken,
			})) {
				if (file.type === 'file') {
					const fileName = file.path.split('/').pop() || file.path;
					if (fileName === '.gitattributes' || fileName === '.gitignore') {
						continue;
					}

					files.push({
						path: file.path,
						size: file.size,
						type: file.type,
						url: this.constructFileUrl(file.path),
						sizeFormatted: formatBytes(file.size),
						lastModified: this.source.kind === 'bucket' ? file.uploadedAt : file.lastCommit?.date,
						lfs: !!file.lfs,
						source: this.source.kind,
					});
				}
			}

			return files.sort((a, b) => a.path.localeCompare(b.path));
		} catch (error) {
			if (error instanceof HfApiError) {
				throw explain(error, `Failed to list files for ${this.source.kind} "${this.source.id}"`);
			}
			throw error;
		}
	}

	/**
	 * Construct the URL for a file
	 */
	private constructFileUrl(filePath: string): string {
		if (this.source.kind === 'bucket') {
			const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
			return `https://huggingface.co/buckets/${this.source.id}/resolve/${encodedPath}`;
		}
		return `https://huggingface.co/datasets/${this.source.id}/resolve/main/${filePath}`;
	}

	/**
	 * Generate detailed markdown report with files grouped by directory
	 */
	async generateDetailedMarkdown(fileType: FileTypeFilter = 'all'): Promise<string> {
		const allFiles = await this.getFiles();
		const files = allFiles.filter((file) => matchesFileType(file, fileType));
		const sourceLabel = this.source.kind === 'bucket' ? 'Hugging Face Bucket' : 'Hugging Face Dataset fallback';

		let markdown = `# Available files in ${this.source.kind}: ${this.source.id}\n\n`;
		markdown += `**Source:** ${sourceLabel}\n`;
		markdown += '**Use:** URLs below can be used as Gradio file inputs when accessible to the target Space.\n\n';
		if (this.source.kind === 'bucket') {
			markdown +=
				'Note: private bucket URLs require authorization. A remote Gradio Space can only fetch these URLs directly if it has access; public buckets are safest for cross-Space file inputs.\n\n';
		}
		if (fileType !== 'all') {
			markdown += `**Filter**: ${fileType} files only\n\n`;
		}

		// Handle empty results
		if (files.length === 0) {
			if (fileType !== 'all') {
				markdown += `No ${fileType} files found in this space.\n`;
			} else {
				markdown += `No files found in this space.\n`;
			}
			return markdown;
		}

		// Generate table
		markdown += `## All Files\n\n`;
		markdown += `| Name | Path | Size | Type | Last Modified | URL |\n`;
		markdown += `|------|------|------|------|---------------|-----|\n`;

		for (const file of files) {
			const fileName = file.path.split('/').pop() || file.path;
			const icon = getFileIcon(fileName);
			const lastMod = file.lastModified ? new Date(file.lastModified).toLocaleDateString() : '-';

			markdown += `| ${escapeMarkdown(fileName)} | ${escapeMarkdown(file.path)} | ${file.sizeFormatted} | ${icon} ${file.type} | ${lastMod} | ${file.url} |\n`;
		}

		return markdown;
	}
}

/**
 * Compatibility wrapper for the legacy gradio_files dataset behavior.
 */
export class GradioFilesTool extends ListFilesTool {
	constructor(hfToken: string, username: string) {
		super(hfToken, { kind: 'dataset', id: `${username}/gradio-files` });
	}

	async getGradioFiles(): Promise<FileWithUrl[]> {
		return this.getFiles();
	}
}
