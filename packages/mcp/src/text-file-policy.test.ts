import { describe, expect, it } from 'vitest';
import { classifyHfFsError } from './hf-fs-errors.js';
import {
	assertTextFilePath,
	classifyTextFilePath,
	decodeTextFileContent,
	imageMimeTypeForPath,
} from './text-file-policy.js';

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

	it('marks every non-text rejection with the stable text-only code', () => {
		for (const run of [
			() => assertTextFilePath('image.png'),
			() => decodeTextFileContent('unknown.file', Uint8Array.from([0xff])),
			() => decodeTextFileContent('unknown.file', Uint8Array.from([0, 1, 2])),
		]) {
			try {
				run();
				throw new Error('Expected text policy to reject the input');
			} catch (error) {
				expect(classifyHfFsError(error)?.code).toBe('HF_FS_TEXT_ONLY');
			}
		}
	});

	it('maps only supported image extensions case-insensitively', () => {
		expect(imageMimeTypeForPath('image.JPG')).toBe('image/jpeg');
		expect(imageMimeTypeForPath('image.jpeg')).toBe('image/jpeg');
		expect(imageMimeTypeForPath('image.PnG')).toBe('image/png');
		expect(imageMimeTypeForPath('image.WEBP')).toBe('image/webp');
		expect(imageMimeTypeForPath('image.gif')).toBeUndefined();
		expect(imageMimeTypeForPath('image.png.txt')).toBeUndefined();
	});

	it('suggests attach only when cat receives a supported image extension', () => {
		try {
			assertTextFilePath('image.PNG');
			throw new Error('Expected image to be rejected');
		} catch (error) {
			expect(classifyHfFsError(error)).toMatchObject({
				code: 'HF_FS_TEXT_ONLY',
				recovery: 'Use attach to return this image to the model, or stat for metadata.',
				suggestedOperation: 'attach',
			});
		}
		try {
			assertTextFilePath('image.gif');
			throw new Error('Expected image to be rejected');
		} catch (error) {
			expect(classifyHfFsError(error)).toMatchObject({
				code: 'HF_FS_TEXT_ONLY',
				suggestedOperation: 'stat',
			});
		}
	});
});
