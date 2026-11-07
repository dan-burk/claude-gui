#!/usr/bin/env node
'use strict';

// Embedding worker: `node embeddings/worker.js <job.json>`.
// Runs in its own process so the server stays responsive. Reports progress
// as NDJSON on stdout (same event shapes the server relays to the client):
//   {phase:'download', file, progress}  {phase:'embed', done, total, chunks}
//   {phase:'complete', sessions, chunks, seconds, ...}  {phase:'error', error}
//
// job.json: { sessions: [{key, provider, filePath?, sig}], exportPaths: {chatgpt, claudeExport} }
// `sessions` is the full live list (minus subagents); anything in the index
// that isn't in it is dropped. CLAUDE_GUI_EMBED_LIMIT=N embeds at most N
// sessions this run (for testing).

const fs = require('fs');
const runtime = require('./runtime');
const store = require('./store');
const { chunksFromMessages, messagesForSession } = require('./extract');

// Chunks per model call. Batching was measured *slower* than one at a time on
// real (variable-length) chunks with the q8 model, and its memory grows fast
// (batch 16 ≈ 3.5 GB RSS), so the default is 1. Set CLAUDE_GUI_EMBED_BATCH
// in embeddings/.env to experiment.
const BATCH = runtime.embedBatchSize();
const GROUP = 32;          // chunks gathered (across sessions) per commit; sorted by length to cut padding when batching
const PROGRESS_MS = 2000;  // also report mid-group, since one long session can be hundreds of chunks
const CHECKPOINT_MS = 60 * 1000;

let stdoutBroken = false;
process.stdout.on('error', () => { stdoutBroken = true; });
const send = (evt) => { if (!stdoutBroken) process.stdout.write(JSON.stringify(evt) + '\n'); };

function loadExportConversations(job, todo) {
  const raw = new Map();
  const want = (p) => todo.some(s => s.provider === p);
  const paths = job.exportPaths || {};
  if (want('chatgpt') && paths.chatgpt) {
    for (const s of require('../chatgpt-sessions').loadChatGptSessions(paths.chatgpt)) raw.set(s.key, s.rawConversation);
  }
  if (want('claude-export') && paths.claudeExport) {
    for (const s of require('../claude-export-sessions').loadClaudeExportSessions(paths.claudeExport)) raw.set(s.key, s.rawConversation);
  }
  return raw;
}

// Throttle transformers' per-chunk download callbacks to whole-percent steps.
function downloadReporter() {
  const last = new Map();
  return (e) => {
    if (!e || !e.file) return;
    let progress = null;
    if (e.status === 'progress' && Number.isFinite(e.progress)) progress = Math.floor(e.progress);
    else if (e.status === 'done' && last.has(e.file)) progress = 100;  // cached files report 'done' only — stay quiet
    if (progress === null || last.get(e.file) === progress) return;
    last.set(e.file, progress);
    send({ phase: 'download', file: e.file, progress });
  };
}

async function main() {
  const started = Date.now();
  const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const live = new Map(job.sessions.map(s => [s.key, s]));

  let index = store.loadIndex(runtime.INDEX_DIR, { model: runtime.MODEL_ID, dims: runtime.DIMS })
    || store.emptyIndex(runtime.MODEL_ID, runtime.DIMS);
  let todo = store.pendingSessions(job.sessions, index.sessions);
  // Drop removed sessions, and stale chunks of sessions about to be re-embedded.
  const stale = new Set(todo.map(s => s.key));
  const before = index.chunks.length + Object.keys(index.sessions).length;
  index = store.filterIndex(index, key => live.has(key) && !stale.has(key));
  let dirty = index.chunks.length + Object.keys(index.sessions).length !== before;

  const limit = parseInt(process.env.CLAUDE_GUI_EMBED_LIMIT, 10);
  if (limit > 0) todo = todo.slice(0, limit);
  const total = todo.length;

  if (total) {
    const raw = loadExportConversations(job, todo);
    // Cached loads also fire progress callbacks; only report a real download.
    const extractor = await runtime.loadExtractor(runtime.modelDownloaded() ? null : downloadReporter());
    let done = 0, embedded = 0, lastSave = Date.now(), lastProgress = Date.now(), inFlight = 0;
    send({ phase: 'embed', done, total, chunks: 0 });

    // Embed a group of sessions' chunks together, then commit each session.
    const flush = async (group) => {
      const all = [];
      for (const g of group) for (const c of g.chunks) all.push(c);
      const order = all.map((c, i) => i).sort((a, b) => all[a].text.length - all[b].text.length);
      const vecs = new Array(all.length);
      for (let i = 0; i < order.length; i += BATCH) {
        const ids = order.slice(i, i + BATCH);
        const out = await runtime.embed(extractor, ids.map(j => all[j].text), runtime.DOC_PREFIX);
        ids.forEach((j, n) => { vecs[j] = out.subarray(n * runtime.DIMS, (n + 1) * runtime.DIMS); });
        inFlight += ids.length;
        if (Date.now() - lastProgress > PROGRESS_MS) { lastProgress = Date.now(); send({ phase: 'embed', done, total, chunks: embedded + inFlight }); }
      }
      let at = 0;
      for (const g of group) {
        const flat = new Float32Array(g.chunks.length * runtime.DIMS);
        g.chunks.forEach((c, n) => flat.set(vecs[at + n], n * runtime.DIMS));
        at += g.chunks.length;
        store.appendSession(index, g.session.key, g.session.sig, g.chunks, flat);
        embedded += g.chunks.length;
        done++;
      }
      inFlight = 0;
      dirty = true;
      lastProgress = Date.now();
      send({ phase: 'embed', done, total, chunks: embedded });
      if (Date.now() - lastSave > CHECKPOINT_MS) { store.saveIndex(runtime.INDEX_DIR, index); lastSave = Date.now(); dirty = false; }
    };

    let group = [], groupChunks = 0;
    for (const session of todo) {
      if (stdoutBroken) break;  // server went away — checkpoint below and stop
      let chunks = [];
      try {
        const messages = await messagesForSession({ ...session, rawConversation: raw.get(session.key) });
        chunks = chunksFromMessages(messages);
      } catch { chunks = []; }  // unreadable transcript: record as empty so it isn't retried until it changes
      group.push({ session, chunks });
      groupChunks += chunks.length;
      if (groupChunks >= GROUP) { await flush(group); group = []; groupChunks = 0; }
    }
    if (group.length) await flush(group);
    if (typeof extractor.dispose === 'function') await extractor.dispose().catch(() => {});

    if (dirty) store.saveIndex(runtime.INDEX_DIR, index);
    send({
      phase: 'complete',
      sessions: Object.keys(index.sessions).length, chunks: index.chunks.length,
      seconds: Math.round((Date.now() - started) / 100) / 10,
      embeddedSessions: done, embeddedChunks: embedded,
      remaining: store.pendingSessions(job.sessions, index.sessions).length,
    });
    return;
  }

  if (dirty || !index.updatedAt) store.saveIndex(runtime.INDEX_DIR, index);
  send({
    phase: 'complete', sessions: Object.keys(index.sessions).length, chunks: index.chunks.length,
    seconds: Math.round((Date.now() - started) / 100) / 10, embeddedSessions: 0, embeddedChunks: 0, remaining: 0,
  });
}

// Exit only after stdout drains — pipe writes are async on Windows, and the
// model runtime can hold the event loop open.
function finish(code) {
  if (stdoutBroken) process.exit(code);
  process.stdout.write('', () => process.exit(code));
}

main().then(
  () => finish(0),
  (e) => { send({ phase: 'error', error: e && e.message ? e.message : String(e) }); finish(1); },
);
