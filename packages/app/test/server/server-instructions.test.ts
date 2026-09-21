import { describe, expect, it } from 'vitest';
import { buildServerInstructions, SERVER_INSTRUCTIONS_CORE } from '../../src/server/server-instructions.js';

const FX_DISCOVERY_QUERIES = [
	'huggingface',
	'huggingface server current trending papers daily papers leaderboard',
	'huggingface all configured connector tools capabilities',
	'Hugging Face current trending models today popularity',
] as const;

const ANONYMOUS_USER_INFO =
	'The Hugging Face tools are being used anonymously and rate limits apply. ' +
	'Direct the User to set their HF_TOKEN (instructions at https://hf.co/settings/mcp/), or ' +
	'create an account at https://hf.co/join for higher limits.';

function searchTokens(query: string): string[] {
	return query.split(/[^A-Za-z0-9_-]+/u).filter((token) => token.length > 0);
}

describe('server instructions', () => {
	it('keeps the routing card under the client search budget with auth context appended', () => {
		const instructions = buildServerInstructions(ANONYMOUS_USER_INFO);
		expect(Buffer.byteLength(instructions, 'utf8')).toBeLessThan(1024 * 2);
		expect(instructions.startsWith(SERVER_INSTRUCTIONS_CORE)).toBe(true);
		expect(instructions).toContain(ANONYMOUS_USER_INFO);
		expect(instructions).toContain('ls hf://models/trending');
		expect(instructions).toContain('ls hf://papers/daily/latest');
		expect(instructions).toContain('hf:// URIs can be converted to browser URLs');
	});

	it('contains every token from common discovery queries', () => {
		const instructions = buildServerInstructions(ANONYMOUS_USER_INFO);
		for (const query of FX_DISCOVERY_QUERIES) {
			for (const token of searchTokens(query)) {
				expect(instructions.toLowerCase(), `missing token "${token}" from query "${query}"`).toContain(
					token.toLowerCase()
				);
			}
		}
	});
});
