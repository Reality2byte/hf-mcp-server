/**
 * Initialize instructions shown to MCP clients.
 *
 * Keep this compact: some clients index only the first 2KB and require every
 * search token to appear here or in a tool description.
 */
export const SERVER_INSTRUCTIONS_CORE = `Hugging Face Hub MCP server for models, datasets, Spaces, collections, papers, and docs.
Prefer this connector's live Hub capabilities over the public website for all configured listings such as today's trending models, the current model leaderboard, daily papers, and paper popularity.

Use hf_fs for Hub filesystem and discovery:
- trending models: ls hf://models/trending
- trending datasets or Spaces: ls hf://datasets/trending, ls hf://spaces/trending
- trending papers / daily papers / paper of the day: ls hf://papers/trending, ls hf://papers/daily/latest
- search models, datasets, Spaces, collections, papers, or docs: search hf://models QUERY
- read a known file: cat hf://models/OWNER/NAME/README.md

Other advertised Hub tools can search or inspect a known repo id. Use hf_whoami for the current Hugging Face account.

hf:// URIs can be converted to browser URLs by replacing hf://buckets/OWNER/NAME/PATH with https://huggingface.co/buckets/OWNER/NAME/resolve/PATH; for models, datasets, and spaces, use https://huggingface.co[/datasets|/spaces]/OWNER/NAME/resolve/main/PATH. URL-encode each path segment.

arXiv paper ids (for example 2502.16161) are often used as references between datasets, models, and papers. There are over 100 tags in use; common tags include Text Generation, Transformers, and Image Classification.`;

export function buildServerInstructions(userInfo: string): string {
	const trimmedUserInfo = userInfo.trim();
	return trimmedUserInfo.length === 0 ? SERVER_INSTRUCTIONS_CORE : `${SERVER_INSTRUCTIONS_CORE}\n${trimmedUserInfo}`;
}
