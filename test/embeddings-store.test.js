'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../embeddings/store');

const DIMS = 4;
const unit = (...v) => { const n = Math.hypot(...v); return v.map(x => x / n); };
const chunk = (role, preview) => ({ role, timestamp: 'ts-' + preview, preview });

function sample() {
  const index = store.emptyIndex('test-model', DIMS);
  store.appendSession(index, 'a', 'sig-a', [chunk('user', 'a0'), chunk('assistant', 'a1')], Float32Array.from([...unit(1, 0, 0, 0), ...unit(0, 1, 0, 0)]));
  store.appendSession(index, 'b', 'sig-b', [chunk('user', 'b0')], Float32Array.from(unit(1, 1, 0, 0)));
  store.appendSession(index, 'c', 'sig-c', [chunk('assistant', 'c0')], Float32Array.from(unit(0, 0, 1, 0)));
  return index;
}

test('appendSession grows vectors and manifest', () => {
  const index = sample();
  assert.equal(index.chunks.length, 4);
  assert.equal(index.vectors.length, 4 * DIMS);
  assert.deepEqual(index.sessions.a, { sig: 'sig-a', chunks: 2 });
  assert.deepEqual(store.chunkInfo(index, 1), { key: 'a', role: 'assistant', timestamp: 'ts-a1', preview: 'a1' });
  assert.throws(() => store.appendSession(index, 'd', 's', [chunk('user', 'x')], new Float32Array(3)));
});

test('rankSessions scores sessions by their best chunk and honours the filter', () => {
  const index = sample();
  const q = Float32Array.from(unit(0, 1, 0, 0));
  const ranked = store.rankSessions(index, q);
  assert.deepEqual(ranked.map(r => r.key), ['a', 'b', 'c']);
  assert.equal(ranked[0].chunk, 1);                     // a's assistant chunk, not its user chunk
  assert.ok(Math.abs(ranked[0].score - 1) < 1e-6);
  assert.ok(Math.abs(ranked[1].score - Math.SQRT1_2) < 1e-6);
  assert.deepEqual(store.rankSessions(index, q, key => key !== 'a').map(r => r.key), ['b', 'c']);
  assert.equal(store.rankSessions(index, q, () => true, 1).length, 1);
});

test('reciprocalRankFusion rewards agreement between lists', () => {
  const fused = store.reciprocalRankFusion([['x', 'y', 'z'], ['y', 'w']], 60);
  assert.equal(fused[0].key, 'y');
  assert.ok(Math.abs(fused[0].score - (1 / 62 + 1 / 61)) < 1e-12);
  assert.deepEqual(fused.map(f => f.key).sort(), ['w', 'x', 'y', 'z']);
});

test('filterIndex drops sessions and keeps vectors aligned', () => {
  const index = store.filterIndex(sample(), key => key !== 'a');
  assert.deepEqual(index.chunks.map(c => c[0]), ['b', 'c']);
  assert.deepEqual(Object.keys(index.sessions).sort(), ['b', 'c']);
  const ranked = store.rankSessions(index, Float32Array.from(unit(0, 0, 1, 0)));
  assert.equal(ranked[0].key, 'c');
  assert.ok(Math.abs(ranked[0].score - 1) < 1e-6);
});

test('pendingSessions finds new and changed sessions', () => {
  const manifest = { a: { sig: '1', chunks: 2 }, b: { sig: '2', chunks: 1 } };
  const pending = store.pendingSessions([{ key: 'a', sig: '1' }, { key: 'b', sig: 'changed' }, { key: 'n', sig: 'x' }], manifest);
  assert.deepEqual(pending.map(s => s.key), ['b', 'n']);
  assert.equal(store.sessionSignature({ lastTs: 't', msgCount: 3, sizeBytes: 10 }), 't|3|10');
});

test('saveIndex/loadIndex round-trip and reject mismatches', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-store-'));
  try {
    const index = sample();
    store.saveIndex(dir, index);
    assert.ok(index.updatedAt);
    const loaded = store.loadIndex(dir, { model: 'test-model', dims: DIMS });
    assert.deepEqual(loaded.chunks, index.chunks);
    assert.deepEqual(Array.from(loaded.vectors), Array.from(index.vectors));
    assert.equal(store.loadIndex(dir, { model: 'other-model' }), null);
    // Appending after a load still works (loaded buffer is exact-size).
    store.appendSession(loaded, 'd', 'sig-d', [chunk('user', 'd0')], Float32Array.from(unit(0, 0, 0, 1)));
    assert.equal(loaded.vectors.length, 5 * DIMS);
    // Truncated vectors file → rejected rather than misaligned.
    fs.writeFileSync(path.join(dir, 'vectors.f32'), Buffer.alloc(8));
    assert.equal(store.loadIndex(dir), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('parseEnv reads KEY=value lines and embedBatchSize defaults to 1', () => {
  const { parseEnv, embedBatchSize } = require('../embeddings/runtime');
  const env = parseEnv('# comment\r\nCLAUDE_GUI_EMBED_BATCH=8\nexport QUOTED="a # b"\nTRAIL=2 # note\nnot a pair\n=x\n');
  assert.deepEqual(env, { CLAUDE_GUI_EMBED_BATCH: '8', QUOTED: 'a # b', TRAIL: '2' });
  assert.equal(embedBatchSize(env), 8);
  assert.equal(embedBatchSize({}), 1);
  assert.equal(embedBatchSize({ CLAUDE_GUI_EMBED_BATCH: 'zero' }), 1);
  assert.equal(embedBatchSize({ CLAUDE_GUI_EMBED_BATCH: '-3' }), 1);
});
