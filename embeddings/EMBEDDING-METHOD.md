# How session embedding works

## The problem

Keyword search only matches exact words. "export path bug" won't find a session that says "couldn't edit the ChatGPT folder setting."

## The idea

An embedding model turns text into a 768-number vector. Similar meanings produce nearby vectors, even with no shared words. Search embeds the query and returns the nearest stored vectors.

Everything runs locally. Chats never leave your machine.

## Step 1: Chunk

Sessions aren't embedded whole, because one vector for a long session blurs its topics together. Each session is split into chunks:

- One chunk per user or assistant turn. Tool calls, tool output and system tags are dropped.
- Turns over **1,800 chars** (~450 tokens) are split at paragraph or sentence breaks, with **150 chars** of overlap.
- Chunks under **15 chars** are dropped.
- Each chunk stores a **200-char preview** for search snippets.

Code: `extract.js`

## Step 2: Embed

The model is `nomic-ai/nomic-embed-text-v1.5`, run on the CPU in Node via `@huggingface/transformers` 3.8.1.

- **Prefixes.** Stored chunks get `search_document: ` and queries get `search_query: `. Nomic was trained with these, so a query lands near the text that *answers* it rather than near similar-looking questions. Omitting them hurts results.
- **q8 quantized.** About 4× smaller and faster, at a small accuracy cost.
- **Mean pooling, normalized.** Per-token vectors are averaged into one vector of length 1, so similarity is a dot product: 1 means the same meaning, ~0 means unrelated.

Code: `runtime.js`

## Step 3: Index

- A background worker process does the embedding, so the app stays responsive.
- **Batch size 1.** Batch 16 was slower on this machine and used ~3.5 GB of RAM. Set `CLAUDE_GUI_EMBED_BATCH` in `embeddings/.env`.
- Chunks are grouped 32 at a time and sorted by length to reduce padding when batching.
- Progress is reported every 2 s, and work is saved every 60 s so interrupted runs resume.
- Only new or changed sessions are re-embedded.

Code: `worker.js`

## Step 4: Search

1. **Semantic:** the query is compared with every chunk. A session scores as its best chunk, and the top 100 sessions go forward.
2. **Keyword:** the existing exact-match search contributes its top 200 hits.
3. **Fusion:** the two rankings are merged with reciprocal rank fusion (k = 60), which favors sessions that rank high on both.
4. The top **30** sessions are returned.

With no index, search falls back to keyword-only.

Code: `service.js`, `store.js`

## Files

| Path | Contents |
|---|---|
| `~/.claude-gui/embed-runtime/` | `@huggingface/transformers` install (~380 MB, incl. native binaries) |
| `~/.claude-gui/models/` | Model (~130 MB) |
| `~/.claude-gui/embeddings/` | Index: `vectors.f32` + chunk metadata |
