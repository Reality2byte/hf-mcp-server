# Space-search regression benchmark

Run date: 14 July 2026

## Production evidence

Source: `~/data/hf-mcp-logs/all-queries-to-latest.jsonl`, covering
2026-07-06 through 2026-07-14.

| Surface | Calls | Successful | Successful zero-result calls |
|---|---:|---:|---:|
| Semantic `space_search` | 11,877 | 11,274 | 3,103 |
| `hub_repo_search` targeting Spaces | 3,306 | 3,300 | 1,857 |
| `hf_fs search hf://spaces...` | 260 | 229 | 181 |

Of semantic searches, 4,436 (37.4%) requested MCP-enabled Spaces. At least
1,329 semantic search calls were followed by `dynamic_space` within ten minutes
in the same client session, making discovery quality relevant to downstream
tool execution.

The semantic and filesystem surfaces are not equivalent:

- `space_search` uses `/api/spaces/semantic-search`;
- `hf_fs` uses keyword search through `/api/spaces`;
- semantic results include descriptions, categories, and relevance;
- filesystem Space entries currently expose repository identifiers and basic
  metadata, but not descriptions;
- `space_search` supports an MCP-only filter; `hf_fs` does not.

Live endpoint probes showed keyword search returning zero results for production
queries such as:

- `Python code execution MCP server`;
- `YouTube transcript extractor MCP`;
- `whisper speech to text transcription audio`;
- `image to 3D model generation`.

The semantic endpoint returned relevant candidates for each.

## GPT-5.6 smoke test

Cases: text-to-image and text-to-video discovery.

| Metric | Semantic legacy | `hf_fs` |
|---|---:|---:|
| Completion | 100% | 0% |
| Error-free | 100% | 100% |
| Mean tokens | 9,879 | 32,847 |
| Mean turns | 4.0 | 9.0 |
| Mean calls | 3.0 | 9.0 |

The filesystem agent found some plausible repositories, then spent its call
budget reading READMEs and application files without producing a final answer.
The semantic agent returned concise, relevant recommendations.

This benchmark should remain as a regression guard. `hf_fs search hf://spaces`
is useful for exact-name, owner-scoped, sorted, and trending lookup, but should
not silently replace semantic Space discovery or MCP-filtered search without
additional capability and result metadata.

## Resolution

Commit `f957eae` changes unscoped `search hf://spaces QUERY` to use the upstream
semantic endpoint. Owner-scoped `search hf://spaces/OWNER QUERY` remains keyword
search. The filesystem command now supports:

```text
search hf://spaces "Python code execution" --kind mcp
search hf://spaces "YouTube transcript" --tag mcp-server
search hf://spaces "image generation" --tag gradio --tag region:us
```

`--kind mcp` is shorthand for the `mcp-server` tag. Repeated tags are required
jointly. Results include descriptions, tags, categories, semantic relevance,
likes, trending score, SDK, and canonical `hf://` URIs.

An Opus smoke rerun on text-to-image and text-to-video prompts produced:

| Metric | Semantic legacy | Semantic `hf_fs` |
|---|---:|---:|
| Completion | 100% | 100% |
| Error-free | 100% | 100% |
| Mean tokens | 4,559 | 5,199 |
| Mean turns | 2.0 | 2.0 |
| Mean calls | 1.5 | 1.5 |

For a Python-execution MCP prompt, Opus independently selected `--kind mcp` and
returned `vmohan-sn/PythonCodeExec` and
`Agents-MCP-Hackathon/TinyCodeAgent`, citing their `mcp-server` tags.
