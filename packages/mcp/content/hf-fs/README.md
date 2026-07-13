# Hugging Face virtual filesystem

Use `hf://` URIs to browse Hugging Face resources:

- `hf://models`
- `hf://datasets`
- `hf://spaces`
- `hf://buckets`
- `hf://collections`
- `hf://papers`

The `hf_fs` tool supports five operations:

- `ls` lists direct children, or bounded descendants with `--recursive`.
- `cat` reads a text or JSON file with `--offset` and `--max-bytes`.
- `stat` inspects one URI.
- `find` traverses descendants beneath one known resource.
- `search` performs API-backed discovery beneath a supported discovery root.

Use `search` for global discovery and `find` for local traversal. Global recursive crawling is intentionally unsupported.

Entries use canonical `hf://` identities. A link has a local `uri` and an authoritative `target_uri`. Directly addressing a supported link resolves to its target, while recursive traversal does not follow links.

Public resources work anonymously. Private or gated resources require a Hugging Face token with access.

## Limits

| Command | Default | Maximum |
|---|---:|---:|
| General `ls` and `find` | 1,000 | 10,000 |
| `search` | 100 | 1,000 |
| `ls hf://models/trending` | 20 | 20 |
| `ls hf://datasets/trending` | 20 | 20 |
| `ls hf://spaces/trending` | 20 | 20 |
| `cat --max-bytes` | 20,000 bytes | 80,000 bytes |

Paper listings have provider-specific limits, generally 100 entries. Use `--limit` only when the request calls for a cap or exhaustive results.

## Examples

```text
ls hf://models/openai --sort downloads --limit 20
ls hf://datasets/OWNER/NAME --recursive --glob **/*.json
find hf://spaces/OWNER/NAME --name app.py --type file
cat hf://models/OWNER/NAME/README.md --offset 20000 --max-bytes 20000
search hf://datasets "speech recognition" --sort downloads --limit 20
ls hf://spaces/trending
```

The MCP input keeps each token separate. For example:

```json
{"cmd":"find","args":["hf://spaces/OWNER/NAME","--name","app.py","--type","file"]}
```

## Trending repositories

The `models`, `datasets`, and `spaces` roots each expose a virtual `trending` directory. These directories return at most 20 entries from the Hugging Face trending feed. `--sort trending` and `--sort trendingScore` are accepted but redundant because the path already determines the order.

## Papers

- Search by topic: `search hf://papers "vision language models"`
- Inspect a paper: `hf://papers/2502.16161`
- Read full text: `hf://papers/2502.16161/paper.md`
- Current Daily Papers: `hf://papers/daily/latest`
- Dated batch: `hf://papers/daily/YYYY/MM/DD`
- Current global ranking: `hf://papers/trending`

See [`hf://papers/README.md`](hf://papers/README.md) for details.

## Sandboxes

For complicated or intensive filesystem operations mount the required repositories in a Sandbox and use shell or Python to programatically inspect them.
