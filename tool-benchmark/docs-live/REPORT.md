# Live docs benchmark report

Run date: 14 July 2026

Evaluation model: `responses.gpt-5.6-sol?reasoning=medium`

The run used six semantic cases, two independently reconstructed prompts per
case, two bouquets, and three repetitions: 72 live prompt executions.

## Aggregate results

| Metric | `bouquet=docs` | `bouquet=files` | Files minus docs |
|---|---:|---:|---:|
| Completion | 100.0% | 88.9% | -11.1 pp |
| Error-free rows | 0.0% | 80.6% | +80.6 pp |
| Mean total tokens | 63,338 | 52,007 | -11,331 (-17.9%) |
| Median total tokens | 47,070 | 43,681 | -3,389 |
| Mean turns | 8.17 | 8.53 | +0.36 |
| Mean tool calls | 7.17 | 7.64 | +0.47 |
| Mean reported duration | 30.7 s | 25.2 s | -5.5 s |

Total measured tokens were 2,280,154 for docs and 1,872,255 for files.

## Repetition stability

Mean token delta per prompt (`files - docs`):

| Repetition | Token delta | Completion delta |
|---|---:|---:|
| 1 | -19,255 | -8.3 pp |
| 2 | -17,921 | -16.7 pp |
| 3 | +3,184 | -8.3 pp |

Across all 36 paired rows, the mean token delta was -11,331 but the median was
only -1,663. Files used fewer tokens in 19 of 36 pairs. The aggregate saving is
therefore real in this sample but driven partly by expensive docs outliers and
is not uniformly reproduced case by case.

Prompt wording had a large effect:

- OpenAI-family prompts: files averaged 6,392 more tokens.
- Anthropic-family prompts: files averaged 29,053 fewer tokens.

This validates retaining both independently reconstructed prompt variants.

## Efficacy findings

All 36 docs rows completed, but every row recovered from at least one failed
semantic search. The traces contained 90 docs tool errors, all upstream search
failures.

Files completed 32 of 36 rows and had eight total tool errors:

- six searches attempted below a docs product root, an unsupported scope;
- one docs search timed out;
- one unrelated model-repository fallback encountered an authentication error.

All four incomplete files rows were Chroma cases that exhausted the 13-call
trace without producing a final assistant answer:

- all three Anthropic-family Chroma prompts;
- one of three OpenAI-family Chroma prompts.

The initial product search for `ChromaPipeline` returned no manifest-backed
result. Agents then attempted filename discovery with patterns such as
`*chroma*`, which do not match nested paths, and several wandered into model
repository inspection before eventually finding:

```text
hf://docs/diffusers/v0.39.0/api/pipelines/chroma.md
hf://docs/diffusers/v0.39.0/api/models/chroma_transformer.md
```

## Interpretation

The filesystem interface substantially reduces exposure to failing upstream
semantic search and reduced aggregate tokens and reported duration in this run.
It did not reduce mean turns or tool calls, and its navigation/search behavior
was less reliable for a deeply nested API-reference task.

The result supports the `hf://docs` direction, but not a claim that it is already
strictly better. The next useful improvements are:

1. improve search recall for class names such as `ChromaPipeline`;
2. make nested filename/path discovery easier or document `**/*chroma*` patterns
   more clearly;
3. make unsupported docs search scopes produce a docs-specific corrective error;
4. rerun this same frozen prompt set after those changes.

Raw outputs, telemetry, traces, scores, and paired deltas are under `runs/live/`.
