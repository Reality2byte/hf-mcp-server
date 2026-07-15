import { describe, expect, it } from 'vitest';
import { parseHfFsWriteRequest } from './hf-fs-write-contract.js';

describe('parseHfFsWriteRequest', () => {
	it('parses put arguments and keeps content separate', () => {
		expect(
			parseHfFsWriteRequest({
				cmd: 'put',
				args: [
					'put',
					'hf://models/org/repo/file.bin',
					'--base64',
					'-m',
					'Upload file',
					'--create-pr',
					'--parent-commit',
					'0123456789abcdef0123456789abcdef01234567',
				],
				content: 'aGVsbG8=',
			})
		).toEqual({
			op: 'put',
			uri: 'hf://models/org/repo/file.bin',
			content: 'aGVsbG8=',
			base64: true,
			message: 'Upload file',
			create_pr: true,
			parent_commit: '0123456789abcdef0123456789abcdef01234567',
		});
	});

	it('validates command arguments and content', () => {
		expect(() => parseHfFsWriteRequest({ cmd: 'put', args: ['hf://models/org/repo/file.txt'] })).toThrow(
			'put requires content'
		);
		expect(() =>
			parseHfFsWriteRequest({
				cmd: 'rm',
				args: ['hf://models/org/repo/file.txt'],
				content: 'no',
			})
		).toThrow('content is only valid with put');
		expect(() =>
			parseHfFsWriteRequest({
				cmd: 'put',
				args: ['hf://models/org/repo/file.txt', '--parent-commit', 'abc'],
				content: 'hello',
			})
		).toThrow('40-character Git commit SHA');
		expect(() =>
			parseHfFsWriteRequest({
				cmd: 'rm',
				args: ['hf://models/org/repo/file.txt', '--base64'],
			})
		).toThrow('unexpected argument for rm: --base64');
	});

	it.each(['--message', '--description', '--branch'])('rejects an empty value for %s', (option) => {
		expect(() =>
			parseHfFsWriteRequest({
				cmd: 'put',
				args: ['hf://models/org/repo/file.txt', option, ''],
				content: 'hello',
			})
		).toThrow(`${option} requires a non-empty value`);
	});
});
