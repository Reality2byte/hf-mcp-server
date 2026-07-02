declare module 'picomatch' {
	export interface PicomatchOptions {
		dot?: boolean;
		nocase?: boolean;
	}

	export interface PicomatchMatcher {
		(input: string): boolean;
	}

	export default function picomatch(glob: string | readonly string[], options?: PicomatchOptions): PicomatchMatcher;
}
