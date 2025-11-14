import type { ToolResult } from '../../types/tool-result.js';
import { SpaceSearchTool, type SpaceSearchResult } from '../../space-search.js';
import { escapeMarkdown } from '../../utilities.js';

// Default number of results to return
const DEFAULT_RESULTS_LIMIT = 10;

/**
 * Prompt configuration for discover operation
 * These prompts can be easily tweaked to adjust the search behavior
 */
const DISCOVER_PROMPTS = {
	// Prefix added to search queries to guide task-focused searches
	TASK_FOCUSED_HINT: 'Find MCP-enabled Gradio Spaces for',

	// Guidance message when no search query is provided
	MISSING_QUERY_HELP: `Error: Missing required parameter: "search_query"

The "discover" operation finds MCP-enabled Spaces that can be invoked using the dynamic_space tool.

**Example - Task-focused search:**
\`\`\`json
{
  "operation": "discover",
  "search_query": "image generation",
  "limit": 10
}
\`\`\`

**Example - With task hint:**
\`\`\`json
{
  "operation": "discover",
  "search_query": "FLUX",
  "task_hint": "text-to-image generation"
}
\`\`\`

**Tip:** Focus your search on specific tasks like:
- "text generation"
- "image generation"
- "video generation"
- "object detection"
- "image classification"
- "text-to-speech"
- "speech-to-text"`,

	// Header for search results
	RESULTS_HEADER: (query: string, showing: number, total: number) => {
		const showingText = showing < total
			? `Showing ${showing} of ${total} results`
			: `All ${showing} results`;
		return `# MCP Space Discovery Results for "${query}" (${showingText})

These MCP-enabled Spaces can be invoked using the \`dynamic_space\` tool.
Use \`"operation": "view_parameters"\` to inspect a space's parameters before invoking.

`;
	},

	// No results message
	NO_RESULTS: (query: string) =>
		`No MCP-enabled Spaces found for "${query}".

Try:
- Broader search terms (e.g., "image generation" instead of specific model names)
- Task-focused queries (e.g., "text generation", "object detection")
- Different task categories (e.g., "video generation", "image classification")`,
};

/**
 * Discovers MCP-enabled Spaces based on search criteria
 *
 * @param searchQuery - The search query (task-focused recommended)
 * @param taskHint - Optional task category hint to refine the search
 * @param limit - Maximum number of results to return
 * @param hfToken - Optional HuggingFace API token
 * @returns Formatted search results
 */
export async function discoverSpaces(
	searchQuery?: string,
	taskHint?: string,
	limit: number = DEFAULT_RESULTS_LIMIT,
	hfToken?: string
): Promise<ToolResult> {
	// Validate required parameters
	if (!searchQuery || searchQuery.trim() === '') {
		return {
			formatted: DISCOVER_PROMPTS.MISSING_QUERY_HELP,
			totalResults: 0,
			resultsShared: 0,
			isError: true,
		};
	}

	try {
		// Construct the final query, optionally incorporating task hint
		const finalQuery = taskHint
			? `${searchQuery} ${taskHint}`.trim()
			: searchQuery;

		// Use SpaceSearchTool to search for MCP-enabled spaces only
		const searchTool = new SpaceSearchTool(hfToken);
		const { results, totalCount } = await searchTool.search(
			finalQuery,
			limit,
			true // mcp = true (only MCP-enabled spaces)
		);

		// Format and return results
		return formatDiscoverResults(searchQuery, results, totalCount);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		return {
			formatted: `Error discovering spaces: ${errorMessage}`,
			totalResults: 0,
			resultsShared: 0,
			isError: true,
		};
	}
}

/**
 * Formats discover results as a markdown table
 * Note: Author column is omitted as it's superfluous for invocation purposes
 */
function formatDiscoverResults(
	query: string,
	results: SpaceSearchResult[],
	totalCount: number
): ToolResult {
	if (results.length === 0) {
		return {
			formatted: DISCOVER_PROMPTS.NO_RESULTS(query),
			totalResults: 0,
			resultsShared: 0,
		};
	}

	let markdown = DISCOVER_PROMPTS.RESULTS_HEADER(query, results.length, totalCount);

	// Table header (without Author column)
	markdown += '| Space | Description | Space ID | Category | Likes | Trending | Relevance |\n';
	markdown += '|-------|-------------|----------|----------|-------|----------|----------|\n';

	// Table rows
	for (const result of results) {
		const title = result.title || 'Untitled';
		const description = result.shortDescription || result.ai_short_description || 'No description';
		const id = result.id || '';
		const emoji = result.emoji ? escapeMarkdown(result.emoji) + ' ' : '';
		const relevance = result.semanticRelevancyScore
			? (result.semanticRelevancyScore * 100).toFixed(1) + '%'
			: 'N/A';

		markdown +=
			`| ${emoji}[${escapeMarkdown(title)}](https://hf.co/spaces/${id}) ` +
			`| ${escapeMarkdown(description)} ` +
			`| \`${escapeMarkdown(id)}\` ` +
			`| \`${escapeMarkdown(result.ai_category ?? '-')}\` ` +
			`| ${escapeMarkdown(result.likes?.toString() ?? '-')} ` +
			`| ${escapeMarkdown(result.trendingScore?.toString() ?? '-')} ` +
			`| ${relevance} |\n`;
	}

	return {
		formatted: markdown,
		totalResults: totalCount,
		resultsShared: results.length,
	};
}
