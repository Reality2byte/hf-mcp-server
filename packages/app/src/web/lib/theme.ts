const THEME_STORAGE_KEY = 'mcp-metrics-theme';

export type Theme = 'light' | 'dark';

export function getPreferredTheme(): Theme {
	try {
		const saved = localStorage.getItem(THEME_STORAGE_KEY);
		if (saved === 'light' || saved === 'dark') return saved;
	} catch {
		// Storage may be unavailable in private or restricted browser contexts.
	}
	return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(theme: Theme): void {
	document.documentElement.classList.toggle('dark', theme === 'dark');
	document.documentElement.style.colorScheme = theme;
}

export function saveTheme(theme: Theme): void {
	applyTheme(theme);
	try {
		localStorage.setItem(THEME_STORAGE_KEY, theme);
	} catch {
		// The switch still works when the preference cannot be persisted.
	}
}
