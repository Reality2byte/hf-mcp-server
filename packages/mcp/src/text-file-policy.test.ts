import { describe, expect, it } from 'vitest';
import { classifyTextFilePath, decodeTextFileContent } from './text-file-policy.js';

describe('text-file-policy', () => {
	it('uses MIME-backed classifications for common text and binary files', () => {
		expect(classifyTextFilePath('README.md')).toBe('text');
		expect(classifyTextFilePath('data/config.json')).toBe('text');
		expect(classifyTextFilePath('assets/image.png')).toBe('binary');
		expect(classifyTextFilePath('docs/manual.pdf')).toBe('binary');
	});

	it('uses overrides for source files and Hub model artifacts MIME does not classify correctly', () => {
		expect(classifyTextFilePath('src/index.ts')).toBe('text');
		expect(classifyTextFilePath('src/app.mts')).toBe('text');
		expect(classifyTextFilePath('scripts/build.py')).toBe('text');
		expect(classifyTextFilePath('weights/model.safetensors')).toBe('binary');
		expect(classifyTextFilePath('weights/model.gguf')).toBe('binary');
	});

	it('treats extensionless repository metadata names as text', () => {
		expect(classifyTextFilePath('Dockerfile')).toBe('text');
		expect(classifyTextFilePath('LICENSE')).toBe('text');
	});

	it('decodes valid UTF-8 text and rejects binary-looking content', () => {
		expect(decodeTextFileContent('unknown.file', new TextEncoder().encode('plain text'))).toBe('plain text');
		expect(() => decodeTextFileContent('unknown.file', Uint8Array.from([0xff]))).toThrow('not valid UTF-8');
		expect(() => decodeTextFileContent('unknown.file', Uint8Array.from([0, 1, 2]))).toThrow('NUL bytes');
	});
});
