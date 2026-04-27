import path from 'node:path';

const TEXT_MIME_BY_EXT: Record<string, string> = {
	'.md': 'text/markdown',
	'.markdown': 'text/markdown',
	'.txt': 'text/plain',
	'.json': 'application/json',
	'.yaml': 'application/yaml',
	'.yml': 'application/yaml',
	'.py': 'text/x-python',
	'.sh': 'application/x-sh',
	'.js': 'text/javascript',
	'.ts': 'text/x-typescript',
	'.tsx': 'text/x-typescript',
	'.jsx': 'text/javascript',
	'.html': 'text/html',
	'.css': 'text/css',
	'.csv': 'text/csv',
	'.toml': 'application/toml',
	'.xml': 'application/xml',
};

const BINARY_MIME_BY_EXT: Record<string, string> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.pdf': 'application/pdf',
	'.zip': 'application/zip',
	'.tar': 'application/x-tar',
	'.gz': 'application/gzip',
	'.tgz': 'application/gzip',
};

export function mimeFor(relPath: string): { mimeType: string; isText: boolean } {
	const ext = path.extname(relPath).toLowerCase();
	const baseLower = path.basename(relPath).toLowerCase();
	if (baseLower === 'license' || baseLower === 'license.txt') {
		return { mimeType: 'text/plain', isText: true };
	}
	if (TEXT_MIME_BY_EXT[ext]) {
		return { mimeType: TEXT_MIME_BY_EXT[ext], isText: true };
	}
	if (BINARY_MIME_BY_EXT[ext]) {
		return { mimeType: BINARY_MIME_BY_EXT[ext], isText: false };
	}
	return { mimeType: 'application/octet-stream', isText: false };
}

export function buildSkillUri(skillName: string, relPath: string): string {
	const normalised = relPath.split(path.sep).join('/');
	return `skill://${skillName}/${normalised}`;
}

export function parseSkillUri(uri: string): { skillName: string; relPath: string } | null {
	if (!uri.startsWith('skill://')) return null;
	const rest = uri.slice('skill://'.length);
	const slash = rest.indexOf('/');
	if (slash <= 0) return null;
	const skillName = rest.slice(0, slash);
	const relPath = rest.slice(slash + 1);
	if (!skillName || !relPath) return null;
	return { skillName, relPath };
}
