/**
 * Utility functions for fetching and processing README files from Hugging Face repositories
 */

import { fetchWithProfile, NETWORK_FETCH_PROFILES } from './network/fetch-profile.js';

// Maximum number of characters to include from a README
const DEFAULT_MAX_README_CHARS = 40_000;

/**
 * Fetches README content from a Hugging Face repository
 *
 * @param repoName The resolved repository name (e.g., 'rajpurkar/squad', 'openai-community/gpt2')
 * @param type The repository type ('models' or 'datasets')
 * @returns Promise<string | null> The README content or null if not found/error
 */
export async function fetchReadmeContent(repoName: string, type: 'models' | 'datasets'): Promise<string | null> {
	try {
		// Construct the URL based on repository type
		const baseUrl =
			type === 'datasets' ? `https://huggingface.co/datasets/${repoName}` : `https://huggingface.co/${repoName}`;

		const url = `${baseUrl}/resolve/main/README.md`;

		const { response } = await fetchWithProfile(url, NETWORK_FETCH_PROFILES.hfHub());

		if (!response.ok) {
			if (response.status === 404) {
				// README doesn't exist, return null silently
				return null;
			}
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		let content = await response.text();

		// Truncate overly long READMEs to a sensible default size
		if (content.length > DEFAULT_MAX_README_CHARS) {
			const truncated = content.slice(0, DEFAULT_MAX_README_CHARS);
			content = `${truncated}\n\n[... truncated to ~${DEFAULT_MAX_README_CHARS.toString()} characters — full README: ${baseUrl}]`;
		}

		// Return null if content is empty after processing
		if (!content.trim()) {
			return null;
		}

		return content;
	} catch (error) {
		// Log error for debugging but don't throw - README is optional
		console.error(`Failed to fetch README for ${repoName}:`, error);
		return null;
	}
}
