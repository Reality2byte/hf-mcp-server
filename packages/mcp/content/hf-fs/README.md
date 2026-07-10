# Hugging Face virtual filesystem

Use `hf://` URIs to browse Hugging Face resources:

- `hf://models`
- `hf://datasets`
- `hf://spaces`
- `hf://buckets`
- `hf://collections`
- `hf://papers`

The `hf_fs` tool supports five operations:

- `ls` lists direct children, or bounded descendants with `recursive: true`.
- `cat` reads a text or JSON file with byte `offset` and `max_bytes`.
- `stat` inspects one URI.
- `find` traverses descendants beneath one known resource.
- `search` performs API-backed discovery beneath a supported discovery root.

Use `search` for global discovery and `find` for local traversal. Global recursive crawling is intentionally unsupported.

Entries use canonical `hf://` identities. A link has a local `uri` and an authoritative `target_uri`. Directly addressing a supported link resolves to its target, while recursive traversal does not follow links.

Public resources work anonymously. Private or gated resources require a Hugging Face token with access.

## Papers

- Search by topic: `search hf://papers query="vision language models"`
- Inspect a paper: `hf://papers/2502.16161`
- Read full text: `hf://papers/2502.16161/paper.md`
- Current Daily Papers: `hf://papers/daily/latest`
- Dated batch: `hf://papers/daily/YYYY/MM/DD`
- Current global ranking: `hf://papers/trending`

See [`hf://papers/README.md`](hf://papers/README.md) for details.
