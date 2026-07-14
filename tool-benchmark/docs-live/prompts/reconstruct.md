You are reconstructing one plausible original user request from an observed
Hugging Face documentation search followed by a documentation page fetch.

Write a natural, self-contained request that would reasonably lead an assistant
to perform this sequence and answer using the fetched documentation.

Requirements:

- Preserve the technical subject and intent implied by the search query and page.
- Do not mention tool names, tool arguments, MCP, logs, benchmarks, search steps,
  or that a page was fetched.
- Do not include the documentation URL.
- Ask for useful information, explanation, or instructions rather than asking
  merely to locate or quote a page.
- Do not invent identifiers, constraints, or a larger task unsupported by the
  observed sequence.
- The request need not uniquely force the exact observed page; this is a live
  efficacy benchmark, not an exact-routing benchmark.
- Use `confidence: low` when the observed sequence is too ambiguous to infer a
  realistic request without substantial invention.
- In `label_note`, briefly explain how the request relates to the observed search
  and fetched page.
- Return only the requested JSON object.
