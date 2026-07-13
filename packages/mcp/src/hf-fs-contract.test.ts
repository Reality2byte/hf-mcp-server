import { describe, expect, it } from 'vitest';

import { parseHfFsRequest } from './hf-fs-contract.js';

describe('parseHfFsRequest', () => {
	it('parses command arguments into canonical parameters', () => {
		expect(
			parseHfFsRequest({
				cmd: 'find',
				args: ['hf://models/openai', '-type', 'model', '-name', '*.json', '--limit', '25'],
			})
		).toEqual({
			params: {
				op: 'find',
				uri: 'hf://models/openai',
				entry_type: 'repo',
				name: '*.json',
				limit: 25,
			},
			warnings: [],
		});
	});

	it('accepts recursive and type aliases', () => {
		expect(
			parseHfFsRequest({
				cmd: 'ls',
				args: ['ls', 'hf://datasets/org/repo', '-R', '--entry-type', 'f'],
			}).params
		).toEqual({
			op: 'ls',
			uri: 'hf://datasets/org/repo',
			recursive: true,
			entry_type: 'file',
		});
	});

	it('accepts positional and flagged search queries', () => {
		expect(
			parseHfFsRequest({
				cmd: 'search',
				args: ['hf://models', 'vision language', '--sort', 'downloads'],
			}).params
		).toEqual({
			op: 'search',
			uri: 'hf://models',
			query: 'vision language',
			sort: 'downloads',
		});
		expect(
			parseHfFsRequest({
				cmd: 'search',
				args: ['hf://datasets/org', '--query', 'speech'],
			}).params
		).toEqual({
			op: 'search',
			uri: 'hf://datasets/org',
			query: 'speech',
		});
	});

	it('softens redundant trending arguments with warnings', () => {
		expect(
			parseHfFsRequest({
				cmd: 'ls',
				args: ['hf://spaces/trending', '--sort', 'trendingScore', '--type', 'space'],
			})
		).toEqual({
			params: {
				op: 'ls',
				uri: 'hf://spaces/trending',
			},
			warnings: [
				'Ignored --sort trendingScore because hf://spaces/trending already implies trending order.',
				'Ignored --type repo because hf://spaces/trending contains only repositories.',
			],
		});
	});

	it.each([
		[{ cmd: 'ls', args: [] }, 'ls requires an hf:// URI'],
		[{ cmd: 'stat', args: ['models/org/repo'] }, 'URI must start with hf://'],
		[{ cmd: 'stat', args: ['hf://models/org/repo', '--limit', '1'] }, 'unexpected argument for stat'],
		[{ cmd: 'ls', args: ['hf://models/org', '--limit'] }, '--limit requires a value'],
		[{ cmd: 'ls', args: ['hf://models/org', '--limit', 'many'] }, '--limit requires an integer'],
		[{ cmd: 'ls', args: ['hf://models/org', '--limit', '1', '--limit', '2'] }, 'duplicate option for limit'],
		[{ cmd: 'search', args: ['hf://models'] }, 'search requires a positional query or --query'],
		[{ cmd: 'search', args: ['hf://models/org/repo', 'query'] }, 'search requires hf://models'],
		[{ cmd: 'search', args: ['hf://models', 'query', '--limit', '1001'] }, 'limit must be between 1 and 1000'],
		[{ cmd: 'ls', args: ['hf://models/trending', '--limit', '21'] }, 'limit must be between 1 and 20'],
		[{ cmd: 'cat', args: ['hf://models/org/repo/README.md', '--max-bytes', '80001'] }, 'max_bytes'],
	] as const)('rejects invalid argv: %o', (request, message) => {
		expect(() => parseHfFsRequest({ cmd: request.cmd, args: [...request.args] })).toThrow(message);
	});
});
