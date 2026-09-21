import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyTheme, getPreferredTheme, saveTheme } from '../../src/web/lib/theme.js';

afterEach(() => vi.unstubAllGlobals());

describe('metrics theme', () => {
	it('uses the system preference when no valid theme was saved', () => {
		vi.stubGlobal('localStorage', { getItem: () => null });
		vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
		expect(getPreferredTheme()).toBe('dark');
		vi.stubGlobal('localStorage', { getItem: () => 'invalid' });
		vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
		expect(getPreferredTheme()).toBe('light');
	});

	it('prefers the saved selection over the system preference', () => {
		vi.stubGlobal('localStorage', { getItem: () => 'light' });
		vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
		expect(getPreferredTheme()).toBe('light');
	});

	it('applies both themes and persists the selection', () => {
		const toggle = vi.fn();
		const style = { colorScheme: '' };
		const setItem = vi.fn();
		vi.stubGlobal('document', { documentElement: { classList: { toggle }, style } });
		vi.stubGlobal('localStorage', { setItem });
		saveTheme('dark');
		expect(toggle).toHaveBeenCalledWith('dark', true);
		expect(style.colorScheme).toBe('dark');
		expect(setItem).toHaveBeenCalledWith('mcp-metrics-theme', 'dark');
		applyTheme('light');
		expect(toggle).toHaveBeenLastCalledWith('dark', false);
		expect(style.colorScheme).toBe('light');
	});

	it('works when browser storage is blocked', () => {
		const blocked = () => {
			throw new Error('Storage blocked');
		};
		vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked });
		vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
		const toggle = vi.fn();
		vi.stubGlobal('document', { documentElement: { classList: { toggle }, style: {} } });
		expect(getPreferredTheme()).toBe('dark');
		expect(() => saveTheme('light')).not.toThrow();
		expect(toggle).toHaveBeenCalledWith('dark', false);
	});
});
