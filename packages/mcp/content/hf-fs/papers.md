# Hugging Face Papers

Search by topic with `search hf://papers query="..."`.

Inspect a known paper at `hf://papers/ARXIV_ID`. For example:

- `hf://papers/2502.16161`
- `hf://papers/2502.16161/paper.md`
- `hf://papers/2502.16161/metadata.json`

`ls hf://papers` shows `README.md`, `daily`, `trending`, and 10 recent papers. Recent papers are only a sample; use `search` for global discovery. Root `limit` controls the sample.

`ls hf://papers/daily` shows `latest` and year directories:

- Current batch: `hf://papers/daily/latest`
- Dated batch: `hf://papers/daily/YYYY/MM/DD`
- First batch: `hf://papers/daily/2023/05/04`

Dated batches are ordered by upvotes, then feed placement. Paper entries include `daily_papers_uri`.

`ls hf://papers/trending` shows the current global Hugging Face ranking. It may include older papers and is not ordered by total upvotes. The ranking score is not available.

Each paper contains:

- `metadata.json`: paper metadata
- `paper.md`: converted full text, or a labelled summary/abstract fallback
- `models/`, `datasets/`, `spaces/`: linked repositories

Links include an authoritative `target_uri`. Recursive `ls` and `find` return links but do not follow them. Daily and trending listings do not recurse into paper directories.

Global recursive listing and global `find` are unsupported.
