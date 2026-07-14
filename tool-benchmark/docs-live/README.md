# Live documentation benchmark

This benchmark compares the current documentation tools with the `hf_fs`
documentation namespace against a locally running MCP server:

- `docs`: `http://localhost:3000/mcp?bouquet=docs`
- `files`: `http://localhost:3000/mcp?bouquet=files`

It measures end-to-end behavior rather than exact tool routing. Primary metrics
are input/output/total tokens, model turns, tool calls, duration, and completion
without tool errors. The answer check is deliberately coarse: a successful row
must produce a non-empty final response, call at least one tool, and have no MCP
tool result marked as an error.

## Dataset

`data/calls.selected.jsonl` contains six public search-to-fetch sequences selected
from:

- `~/data/hf-mcp-logs/hf_docs_search-usage.jsonl`
- `~/data/hf-mcp-logs/hf_docs_fetch-usage.jsonl`

Only the observed search query, optional product, fetched documentation URL, and
aggregate occurrence count are retained. Session IDs, timestamps, responses,
authentication state, and request metadata are excluded.

The cases cover:

- unscoped documentation discovery;
- product-scoped searches;
- class and API reference lookup;
- conceptual documentation;
- versionless and explicit-language source URLs.

## 1. Reverse-generate prompts with two model families

Generate one plausible original user request per observed tool sequence with two
independent model families:

```bash
fast-agent batch run \
  --input tool-benchmark/docs-live/data/calls.selected.jsonl \
  --output tool-benchmark/docs-live/runs/prompts/openai.jsonl \
  --instruction tool-benchmark/docs-live/prompts/reconstruct.md \
  --json-schema tool-benchmark/docs-live/schemas/reconstructed-prompt.schema.json \
  --model 'responses.gpt-5.6-sol?reasoning=high' \
  --id-field id \
  --parallel 4 \
  --include-input \
  --overwrite

fast-agent batch run \
  --input tool-benchmark/docs-live/data/calls.selected.jsonl \
  --output tool-benchmark/docs-live/runs/prompts/anthropic.jsonl \
  --instruction tool-benchmark/docs-live/prompts/reconstruct.md \
  --json-schema tool-benchmark/docs-live/schemas/reconstructed-prompt.schema.json \
  --model 'opus48' \
  --id-field id \
  --parallel 4 \
  --include-input \
  --overwrite
```

Retain both prompt variants:

```bash
python tool-benchmark/docs-live/scripts/build_prompt_set.py \
  --calls tool-benchmark/docs-live/data/calls.selected.jsonl \
  --family openai=tool-benchmark/docs-live/runs/prompts/openai.jsonl \
  --family anthropic=tool-benchmark/docs-live/runs/prompts/anthropic.jsonl \
  --output tool-benchmark/docs-live/data/prompts.dual.jsonl
```

This produces twelve benchmark rows from six semantic cases.

## 2. Start the local MCP server

Run the server separately on port 3000. Verify both bouquets before starting an
evaluation:

```bash
curl -i 'http://localhost:3000/mcp?bouquet=docs'
curl -i 'http://localhost:3000/mcp?bouquet=files'
```

The exact response to a plain GET depends on the MCP transport; connection
refusal or timeout means the benchmark should not be started.

## 3. Run the live comparison

Use the same evaluation model, prompts, repetition count, and parallelism for
both bouquets:

```bash
python tool-benchmark/docs-live/scripts/run_live.py \
  --model 'gpt56=responses.gpt-5.6-sol?reasoning=medium' \
  --runs 3 \
  --parallel 1
```

Artifacts are written under `tool-benchmark/docs-live/runs/live/`:

- batch outputs;
- normalized telemetry;
- row-local Codex traces;
- per-run scores;
- `matrix-summary.json`, `matrix-summary.csv`, and `paired-deltas.csv`.

Use `--limit 2` for a smoke test. Fast-agent currently requires serial execution
when exporting row-local traces, so `run_live.py` rejects `--parallel` values
other than 1. The local server is live and mutable; interpret small score
differences cautiously.

## Scoring notes

`fast-agent batch --export-traces` captures each row's complete tool loop.
`score_live.py` sums `last_token_usage` from each row-local `token_count` event;
it does not use cumulative worker-session counters.

Reported efficacy fields are intentionally weak:

- batch invocation completed;
- at least one tool was called;
- the trace ended with an assistant answer rather than an unfinished tool call;
- final response was non-empty.

Tool-result errors are reported separately. A row may complete after recovering
from a failed search or read, which is useful efficacy information rather than
an automatic benchmark failure.

The benchmark does not grade exact prose or require a specific page. Review
failed rows and a small sample of successful traces before drawing conclusions.
Paired deltas are reported as `files - docs`, so negative token, turn, tool-call,
or duration deltas favor the filesystem variant.
