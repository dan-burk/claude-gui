'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  cleanText, chunkText, turnsFromMessages, chunksFromMessages, readClaudeMessages, messagesForSession,
} = require('../embeddings/extract');

const turn = (role, parts, timestamp = '2026-01-01T00:00:00Z') => ({ type: 'turn', role, timestamp, parts });
const text = (t) => ({ kind: 'text', text: t });

test('cleanText strips harness blocks from user text only', () => {
  const user = [
    '<system-reminder>ignore me\nentirely</system-reminder>',
    '<command-name>/clear</command-name><command-message>clear</command-message><command-args></command-args>',
    '<local-command-stdout>output</local-command-stdout>',
    'Please   refactor the parser.',
    '[Request interrupted by user]',
  ].join('\n');
  assert.equal(cleanText(user, 'user'), 'Please refactor the parser.');
  // Assistant prose that mentions a tag is left alone.
  assert.match(cleanText('Use <system-reminder>x</system-reminder> blocks', 'assistant'), /system-reminder/);
  // Unterminated harness block is dropped to the end.
  assert.equal(cleanText('Real question here\n<task-notification>cut off', 'user'), 'Real question here');
});

test('chunkText keeps short text whole and splits long text with overlap', () => {
  assert.deepEqual(chunkText('short text'), ['short text']);
  const paras = Array.from({ length: 12 }, (_, i) => `Paragraph ${i}. ` + 'word '.repeat(60).trim() + '.');
  const long = paras.join('\n\n');
  const chunks = chunkText(long, 1800, 150);
  assert.ok(chunks.length >= 3);
  for (const c of chunks) assert.ok(c.length <= 1800, `chunk too long: ${c.length}`);
  // Cuts land on paragraph boundaries: every chunk but the overlap head ends with a full stop.
  for (const c of chunks.slice(0, -1)) assert.match(c, /\.$/);
  // Overlap: the start of each later chunk appears near the end of the previous one.
  for (let i = 1; i < chunks.length; i++) assert.ok(chunks[i - 1].includes(chunks[i].slice(0, 20)));
  // Nothing lost: every paragraph header survives.
  for (let i = 0; i < 12; i++) assert.ok(chunks.some(c => c.includes(`Paragraph ${i}.`)));
});

test('chunkText hard-splits text with no boundaries', () => {
  const chunks = chunkText('x'.repeat(5000), 1800, 150);
  assert.ok(chunks.length >= 3);
  for (const c of chunks) assert.ok(c.length <= 1800);
});

test('turnsFromMessages merges same-role runs and ignores tools/summaries', () => {
  const turns = turnsFromMessages([
    turn('user', [text('How do I parse JSONL?')]),
    turn('assistant', [text('Let me look.'), { kind: 'tool_use', name: 'Read', summary: 'x' }]),
    turn('user', [{ kind: 'tool_result', text: 'file contents that must not be embedded' }]),
    turn('assistant', [text('Use readline.')]),
    { type: 'summary', text: 'summary text' },
    turn('user', [text('<system-reminder>only noise</system-reminder>')]),
    turn('user', [text('Thanks!')], '2026-01-02T00:00:00Z'),
  ]);
  assert.deepEqual(turns.map(t => [t.role, t.text]), [
    ['user', 'How do I parse JSONL?'],
    ['assistant', 'Let me look.\n\nUse readline.'],
    ['user', 'Thanks!'],
  ]);
  assert.equal(turns[2].timestamp, '2026-01-02T00:00:00Z');
});

test('chunksFromMessages drops very short chunks and builds previews', () => {
  const long = 'Explain the architecture in detail. '.repeat(100);
  const chunks = chunksFromMessages([
    turn('user', [text('ok')]),
    turn('assistant', [text(long)]),
  ]);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every(c => c.role === 'assistant'));
  assert.ok(chunks.every(c => c.preview.length <= 200));
  assert.ok(chunks[0].text.startsWith('Explain the architecture'));
});

test('readClaudeMessages reads text parts and skips isMeta lines', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-embed-'));
  const file = path.join(dir, 's.jsonl');
  const lines = [
    { type: 'user', isMeta: true, message: { role: 'user', content: 'Skill body injected by the harness' }, timestamp: 't0' },
    { type: 'user', message: { role: 'user', content: 'Why is the build failing on Windows?' }, timestamp: 't1' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Checking the logs.' }, { type: 'tool_use', name: 'Bash', input: {} }] }, timestamp: 't2' },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'giant log output' }] }, timestamp: 't3' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'The path separator is wrong.' }] }, timestamp: 't4' },
    { type: 'system', subtype: 'away_summary', content: 'summary' },
  ];
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\nnot json\n');
  try {
    const messages = await messagesForSession({ provider: 'claude', filePath: file });
    assert.equal(messages.length, 4);
    const chunks = chunksFromMessages(await readClaudeMessages(file));
    assert.deepEqual(chunks.map(c => [c.role, c.text, c.timestamp]), [
      ['user', 'Why is the build failing on Windows?', 't1'],
      ['assistant', 'Checking the logs.\n\nThe path separator is wrong.', 't2'],
    ]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('messagesForSession handles export providers and unknown providers', async () => {
  const conversation = {
    uuid: '11111111-2222-4333-8444-555555555555', name: 'Chat', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    chat_messages: [
      { sender: 'human', text: 'What is a vector index?', created_at: '2026-01-01T00:00:00Z', content: [{ type: 'text', text: 'What is a vector index?' }] },
      { sender: 'assistant', text: 'A structure for nearest-neighbour lookups.', created_at: '2026-01-01T00:00:01Z', content: [{ type: 'text', text: 'A structure for nearest-neighbour lookups.' }] },
    ],
  };
  const chunks = chunksFromMessages(await messagesForSession({ provider: 'claude-export', rawConversation: conversation }));
  assert.deepEqual(chunks.map(c => c.role), ['user', 'assistant']);
  assert.deepEqual(await messagesForSession({ provider: 'nope' }), []);
});
