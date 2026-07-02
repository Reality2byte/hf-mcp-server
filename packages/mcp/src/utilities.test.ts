import { describe, expect, it } from 'vitest';
import { DEFAULT_CHARS_PER_TOKEN, estimateTokens, fitsWithinCharBudget, maxCharsForTokenBudget } from './utilities.js';

describe('token and character budget utilities', () => {
	it('estimates tokens from the shared default chars-per-token ratio', () => {
		expect(estimateTokens('x'.repeat(34))).toBe(Math.ceil(34 / DEFAULT_CHARS_PER_TOKEN));
	});

	it('converts token budgets to character budgets', () => {
		expect(maxCharsForTokenBudget(12_500, 3)).toBe(37_500);
		expect(maxCharsForTokenBudget(20_000, 4)).toBe(80_000);
	});

	it('checks character budgets inclusively', () => {
		expect(fitsWithinCharBudget('abcd', 4)).toBe(true);
		expect(fitsWithinCharBudget('abcde', 4)).toBe(false);
	});
});
