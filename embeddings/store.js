'use strict';

// On-disk vector index + search math.
//
// Layout (in the index dir):
//   vectors.f32  every chunk's normalized embedding, Float32 little-endian,
//                concatenated in chunk order (chunk i = floats [i*dims, (i+1)*dims))
//   meta.json    { version, model, dims, updatedAt,
//                  sessions: { <key>: { sig, chunks } },   // manifest
//                  chunks:   [[key, role, timestamp, preview], ...] }
// Chunks of one session are contiguous. Vectors are unit length, so cosine
// similarity is a plain dot product.

const fs = require('fs');
const path = require('path');

const FORMAT_VERSION = 1;
const ROLE_CODE = { user: 'u', assistant: 'a' };
const ROLE_NAME = { u: 'user', a: 'assistant' };

// Change signature for incremental indexing — the same session re-embeds
// only when this string changes.
function sessionSignature(s) {
  return `${s.lastTs || ''}|${s.msgCount || 0}|${s.sizeBytes || 0}`;
}

function emptyIndex(model, dims) {
  return { version: FORMAT_VERSION, model, dims, updatedAt: null, sessions: {}, chunks: [], vectors: new Float32Array(0) };
}

function metaPath(dir) { return path.join(dir, 'meta.json'); }
function vectorsPath(dir) { return path.join(dir, 'vectors.f32'); }

function readMeta(dir) {
  try { return JSON.parse(fs.readFileSync(metaPath(dir), 'utf8')); } catch { return null; }
}

// Full index, or null when absent/corrupt/built with a different model.
function loadIndex(dir, expect = {}) {
  const meta = readMeta(dir);
  if (!meta || meta.version !== FORMAT_VERSION || !Array.isArray(meta.chunks)) return null;
  if (expect.model && meta.model !== expect.model) return null;
  if (expect.dims && meta.dims !== expect.dims) return null;
  let buf;
  try { buf = fs.readFileSync(vectorsPath(dir)); } catch { return null; }
  if (buf.length !== meta.chunks.length * meta.dims * 4) return null;
  // Copy into an aligned buffer — readFileSync's Buffer may sit at an odd offset in a pool.
  const vectors = new Float32Array(meta.chunks.length * meta.dims);
  new Uint8Array(vectors.buffer).set(buf);
  return { ...meta, vectors };
}

// Atomic-ish save: write temps, then rename vectors before meta so a crash
// leaves either the old pair or a size mismatch that loadIndex rejects.
function saveIndex(dir, index) {
  fs.mkdirSync(dir, { recursive: true });
  const { vectors, ...meta } = index;
  meta.updatedAt = new Date().toISOString();
  index.updatedAt = meta.updatedAt;
  const vTmp = vectorsPath(dir) + '.tmp';
  const mTmp = metaPath(dir) + '.tmp';
  fs.writeFileSync(vTmp, Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength));
  fs.writeFileSync(mTmp, JSON.stringify(meta));
  fs.renameSync(vTmp, vectorsPath(dir));
  fs.renameSync(mTmp, metaPath(dir));
}

// Keep only chunks whose session passes `keep(key)`; rebuilds the manifest
// counts to match. Returns a new index object.
function filterIndex(index, keep) {
  const dims = index.dims;
  const keepIdx = [];
  for (let i = 0; i < index.chunks.length; i++) if (keep(index.chunks[i][0])) keepIdx.push(i);
  const vectors = new Float32Array(keepIdx.length * dims);
  keepIdx.forEach((src, dst) => vectors.set(index.vectors.subarray(src * dims, (src + 1) * dims), dst * dims));
  const sessions = {};
  for (const [key, entry] of Object.entries(index.sessions)) if (keep(key)) sessions[key] = entry;
  return { ...index, sessions, chunks: keepIdx.map(i => index.chunks[i]), vectors };
}

// Append one session's chunks + vectors (flat Float32Array, chunks.length*dims).
function appendSession(index, key, sig, chunks, vectors) {
  const dims = index.dims;
  if (vectors.length !== chunks.length * dims) throw new Error('vector/chunk count mismatch');
  // Grow a backing buffer geometrically; index.vectors stays an exact-length view.
  const used = index.vectors.length;
  const need = used + vectors.length;
  let buf = index.vectors.buffer.byteLength >= need * 4 && index.vectors.byteOffset === 0 ? index.vectors.buffer : null;
  if (!buf) {
    buf = new ArrayBuffer(Math.max(need, used * 2, dims * 1024) * 4);
    new Float32Array(buf).set(index.vectors, 0);
  }
  new Float32Array(buf, used * 4, vectors.length).set(vectors);
  index.vectors = new Float32Array(buf, 0, need);
  for (const c of chunks) index.chunks.push([key, ROLE_CODE[c.role] || 'u', c.timestamp || '', c.preview || '']);
  index.sessions[key] = { sig, chunks: chunks.length };
}

// Sessions (from the live list) that are new or changed relative to the manifest.
function pendingSessions(sessions, manifest) {
  const m = manifest || {};
  return sessions.filter(s => !m[s.key] || m[s.key].sig !== s.sig);
}

// ── Search math ───────────────────────────────────────────────────────
function dot(a, aOff, b, bOff, n) {
  let s = 0;
  for (let i = 0; i < n; i++) s += a[aOff + i] * b[bOff + i];
  return s;
}

// Best-scoring chunk per session (session score = max chunk similarity).
// `allow(key)` filters sessions. Returns [{key, score, chunk}] sorted desc.
function rankSessions(index, query, allow = () => true, limit = 100) {
  const dims = index.dims;
  const best = new Map();
  for (let i = 0; i < index.chunks.length; i++) {
    const key = index.chunks[i][0];
    if (!allow(key)) continue;
    const score = dot(index.vectors, i * dims, query, 0, dims);
    const cur = best.get(key);
    if (!cur || score > cur.score) best.set(key, { key, score, chunk: i });
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

// Reciprocal rank fusion: each list is an array of keys, best first.
// Returns [{key, score}] sorted desc.
function reciprocalRankFusion(lists, k = 60) {
  const scores = new Map();
  for (const list of lists) {
    list.forEach((key, rank) => scores.set(key, (scores.get(key) || 0) + 1 / (k + rank + 1)));
  }
  return [...scores.entries()].map(([key, score]) => ({ key, score })).sort((a, b) => b.score - a.score);
}

function chunkInfo(index, i) {
  const [key, role, timestamp, preview] = index.chunks[i];
  return { key, role: ROLE_NAME[role] || role, timestamp, preview };
}

module.exports = {
  FORMAT_VERSION, sessionSignature, emptyIndex, readMeta, loadIndex, saveIndex,
  filterIndex, appendSession, pendingSessions, rankSessions, reciprocalRankFusion, chunkInfo, dot,
};
