# Live Space-search regression benchmark

This benchmark compares two isolated Space discovery surfaces:

- `legacy`: semantic `space_search`;
- `files`: keyword/owner search through `hf_fs search hf://spaces`.

The cases come from production calls in
`~/data/hf-mcp-logs/all-queries-to-latest.jsonl`. They intentionally cover both
surfaces' strengths:

- conceptual capability discovery;
- MCP-enabled capability discovery;
- exact Space/model-family names;
- owner-scoped discovery.

Operational scoring reuses `tool-benchmark/docs-live/scripts/score_live.py`.
Completion is not a relevance grade: review cited Spaces for task fit, and for
MCP prompts verify that recommended Spaces are actually MCP-enabled.

## Isolated servers

The current filesystem server can use the normal files bouquet on port 3000:

```bash
pnpm start
```

Start a second server that exposes only legacy `space_search`:

```bash
PORT=3001 \
DISABLE_TOOLS=hf_fs,duplicate_space,space_info,space_files,use_space \
pnpm start
```

The agent cards point to these two endpoints.

## Run

```bash
python tool-benchmark/spaces-live/scripts/run_live.py \
  --model 'gpt56=responses.gpt-5.6-sol?reasoning=medium' \
  --runs 1 \
  --output-dir tool-benchmark/spaces-live/runs/live
```

Fast-agent trace export requires serial execution.
