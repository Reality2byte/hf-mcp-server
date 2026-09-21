import { useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { Button } from './ui/button';
import { getPreferredTheme, saveTheme } from '../lib/theme';

export function ThemeToggle() {
	const [theme, setTheme] = useState(getPreferredTheme);
	const label = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';

	return (
		<Button
			type="button"
			variant="outline"
			size="icon"
			aria-label={label}
			title={label}
			onClick={() => {
				const nextTheme = theme === 'dark' ? 'light' : 'dark';
				saveTheme(nextTheme);
				setTheme(nextTheme);
			}}
		>
			{theme === 'dark' ? (
				<Sun className="size-4" aria-hidden="true" />
			) : (
				<Moon className="size-4" aria-hidden="true" />
			)}
		</Button>
	);
}
