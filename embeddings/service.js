'use strict';

// Server-side glue for semantic search: status, running the embedding worker,
// and hybrid (vector + keyword) search. index.js wires these to routes and
// supplies the session list and keyword-snippet helper.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const runtime = require('./runtime');
const store = require('./store');

const WORKER = path.join(__dirname, 'worker.js');
const MAX_RESULTS = 30;
const RRF_K = 60;
const KEYWORD_POOL = 200;   // keyword hits fed into fusion
const SEMANTIC_POOL = 100;  // sessions (by best chunk) fed into fusion

const state = {
  running: false,
  tools: {},              // cached successful detections: { node, npm }
  meta: null, metaMtime: 0,     // parsed meta.json (manifest), for status/pending
  index: null, indexMtime: 0,   // full index incl. vectors, for search
  extractor: null,              // Promise<pipeline> — loaded once per process
};

const isEligible = (s) => !s.isSubagent;
const sessionKey = (s) => s.key || s.id;

function metaMtime() {
  try { return fs.statSync(path.join(runtime.INDEX_DIR, 'meta.json')).mtimeMs; } catch { return 0; }
}

function currentMeta() {
  const m = metaMtime();
  if (!m) { state.meta = null; state.metaMtime = 0; return null; }
  if (m !== state.metaMtime) {
    const meta = store.readMeta(runtime.INDEX_DIR);
    state.meta = meta && meta.model === runtime.MODEL_ID ? meta : null;
    state.metaMtime = m;
  }
  return state.meta;
}

function currentIndex() {
  const m = metaMtime();
  if (!m) { state.index = null; return null; }
  if (!state.index || m !== state.indexMtime) {
    state.index = store.loadIndex(runtime.INDEX_DIR, { model: runtime.MODEL_ID, dims: runtime.DIMS });
    state.indexMtime = m;
  }
  return state.index;
}

async function detect(name) {
  if (state.tools[name]) return state.tools[name];
  const r = await runtime.detectTool(name);
  if (r.installed) state.tools[name] = r;
  return r;
}

// The worker's view of a session: enough to find and re-read its transcript.
function jobSessions(sessions, claudeProjectsDir) {
  return sessions.filter(isEligible).map(s => ({
    key: sessionKey(s),
    provider: s.provider,
    filePath: s.provider === 'claude' ? path.join(claudeProjectsDir, s.projectDir, `${s.id}.jsonl`) : (s.filePath || ''),
    sig: store.sessionSignature(s),
  }));
}

function countPending(sessions, meta) {
  const live = sessions.filter(isEligible).map(s => ({ key: sessionKey(s), sig: store.sessionSignature(s) }));
  return store.pendingSessions(live, meta ? meta.sessions : {}).length;
}

async function status(sessions) {
  const [node, npm] = await Promise.all([detect('node'), detect('npm')]);
  const meta = currentMeta();
  return {
    node, npm,
    runtimeInstalled: runtime.runtimeInstalled(),
    modelDownloaded: runtime.modelDownloaded(),
    model: runtime.MODEL_ID,
    modelSizeMB: runtime.MODEL_SIZE_MB,
    index: meta ? { sessions: Object.keys(meta.sessions || {}).length, chunks: (meta.chunks || []).length, updatedAt: meta.updatedAt } : null,
    pending: countPending(sessions, meta),
    running: state.running,
  };
}

// Pre-flight for POST /api/embed. Returns {status, error} to reject, or null.
async function preflight() {
  if (state.running) return { status: 409, error: 'An embedding run is already in progress' };
  const [node, npm] = await Promise.all([detect('node'), detect('npm')]);
  if (!node.installed) return { status: 400, error: 'Node.js was not found on PATH' };
  if (!npm.installed && !runtime.runtimeInstalled()) return { status: 400, error: 'npm was not found on PATH (needed once to install the embedding runtime)' };
  return null;
}

// Install (if needed) and run the worker, relaying its NDJSON events to send().
// Resolves when the run ends; never rejects (errors become {phase:'error'}).
async function run({ getSessions, claudeProjectsDir, exportPaths, send }) {
  if (state.running) { send({ phase: 'error', error: 'An embedding run is already in progress' }); return; }
  state.running = true;
  try {
    if (!runtime.runtimeInstalled()) {
      send({ phase: 'install', message: `Installing ${runtime.PACKAGE}@${runtime.PACKAGE_VERSION} into ${runtime.RUNTIME_DIR}` });
      await runtime.installRuntime(line => send({ phase: 'install', message: line }));
      send({ phase: 'install', message: 'Embedding runtime installed' });
    }
    const sessions = await getSessions();
    fs.mkdirSync(runtime.INDEX_DIR, { recursive: true });
    const jobPath = path.join(runtime.INDEX_DIR, 'job.json');
    fs.writeFileSync(jobPath, JSON.stringify({ sessions: jobSessions(sessions, claudeProjectsDir), exportPaths }));

    await new Promise((resolve) => {
      const child = spawn(process.execPath, [WORKER, jobPath], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: process.env });
      let buf = '', errTail = '', finished = false;
      child.stdout.on('data', (d) => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let evt; try { evt = JSON.parse(line); } catch { continue; }
          if (evt.phase === 'complete' || evt.phase === 'error') finished = true;
          send(evt);
        }
      });
      child.stderr.on('data', (d) => { errTail = (errTail + d).slice(-2000); });
      child.on('error', (e) => { if (!finished) { finished = true; send({ phase: 'error', error: e.message }); } resolve(); });
      child.on('close', (code) => {
        if (!finished) send({ phase: 'error', error: `embedding worker exited (code ${code})${errTail.trim() ? ': ' + errTail.trim().split('\n').slice(-3).join(' ') : ''}` });
        resolve();
      });
    });
  } catch (e) {
    send({ phase: 'error', error: e.message });
  } finally {
    state.running = false;
    state.index = null;  // reload on next search
    state.meta = null; state.metaMtime = 0;
  }
}

// Keyword hits ranked by occurrence count (capped), then list order (recency).
function keywordRank(sessions, qLower, makeSnippet) {
  const hits = [];
  sessions.forEach((s, order) => {
    const text = s.searchLower || '';
    let i = text.indexOf(qLower);
    if (i < 0) return;
    const first = i;
    let count = 0;
    while (i >= 0 && count < 20) { count++; i = text.indexOf(qLower, i + qLower.length); }
    hits.push({ key: sessionKey(s), count, order, snippet: makeSnippet(s.searchText, first, qLower.length) });
  });
  hits.sort((a, b) => b.count - a.count || a.order - b.order);
  return hits.slice(0, KEYWORD_POOL);
}

function semanticReady() {
  return runtime.runtimeInstalled() && runtime.modelDownloaded() && currentMeta() && currentMeta().chunks.length > 0;
}

async function embedQuery(q) {
  if (!state.extractor) {
    state.extractor = runtime.loadExtractor(null, { enableCpuMemArena: false }).catch((e) => { state.extractor = null; throw e; });
  }
  const extractor = await state.extractor;
  return runtime.embed(extractor, [q], runtime.QUERY_PREFIX);
}

// { mode: 'hybrid'|'keyword', results: [{key, score, snippet, role, timestamp}] }
async function search({ sessions, q, scope, project, makeSnippet }) {
  const query = String(q || '').trim();
  if (!query) return { mode: semanticReady() ? 'hybrid' : 'keyword', results: [] };
  const pool = sessions.filter(s => isEligible(s) && (scope !== 'project' || (s.projectKey || s.projectDir) === project));
  const keyword = keywordRank(pool, query.toLowerCase(), makeSnippet);

  let semantic = null, index = null;
  if (semanticReady()) {
    try {
      index = currentIndex();
      if (index && index.chunks.length) {
        const allowed = new Set(pool.map(sessionKey));
        const qv = await embedQuery(query);
        semantic = store.rankSessions(index, qv, key => allowed.has(key), SEMANTIC_POOL);
      }
    } catch { semantic = null; }  // runtime/model trouble — degrade to keyword
  }

  if (!semantic) {
    return {
      mode: 'keyword',
      results: keyword.slice(0, MAX_RESULTS).map((h, rank) => ({
        key: h.key, score: 1 / (RRF_K + rank + 1), snippet: h.snippet, role: null, timestamp: null, match: 'keyword',
      })),
    };
  }

  const kwByKey = new Map(keyword.map(h => [h.key, h]));
  const semByKey = new Map(semantic.map(h => [h.key, h]));
  const fused = store.reciprocalRankFusion([semantic.map(h => h.key), keyword.map(h => h.key)], RRF_K);
  const results = fused.slice(0, MAX_RESULTS).map(({ key, score }) => {
    const sem = semByKey.get(key), kw = kwByKey.get(key);
    const base = { key, score, match: sem && kw ? 'both' : sem ? 'semantic' : 'keyword' };
    if (sem) {
      const c = store.chunkInfo(index, sem.chunk);
      return { ...base, snippet: c.preview, role: c.role, timestamp: c.timestamp || null, similarity: Math.round(sem.score * 1000) / 1000 };
    }
    return { ...base, snippet: kw.snippet, role: null, timestamp: null };
  });
  return { mode: 'hybrid', results };
}

module.exports = { status, preflight, run, search, jobSessions, keywordRank };
