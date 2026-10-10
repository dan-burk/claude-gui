#!/usr/bin/env node
'use strict';

// Copies the opening of a real Claude Code session into the demo's sample home
// (demo/home/.claude/projects/<project>/<id>.jsonl), in Claude Code's own
// format. Run by hand when changing the samples; the build never touches your
// real ~/.claude.
//
//   node demo/extract.js <session.jsonl> <prompts>
//
// Keeps everything up to the reply to the <prompts>-th thing you typed, and
// trims what a visitor doesn't need to see: harness-injected messages and
// <system-reminder> blocks, thinking, subagent traffic, bookkeeping lines, and
// the bulk of long tool output.

const fs = require('fs');
const path = require('path');

const MAX_RESULT_CHARS = 2000;
const MAX_INPUT_CHARS = 2000;
const KEEP_FIELDS = ['parentUuid', 'isSidechain', 'userType', 'cwd', 'sessionId', 'version', 'gitBranch', 'type', 'subtype', 'content', 'message', 'uuid', 'timestamp'];

const [file, count] = process.argv.slice(2);
if (!file || !(Number(count) > 0)) {
  console.error('usage: node demo/extract.js <session.jsonl> <prompts>');
  process.exit(1);
}

const trim = (text, max) => text.length <= max ? text : `${text.slice(0, max)}\n…[trimmed for the demo]`;
const stripReminders = (text) => text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();

// Something the person typed, as opposed to a tool result or harness text.
function isPrompt(d) {
  if (d.type !== 'user' || d.isMeta || !d.message) return false;
  const c = d.message.content;
  const text = typeof c === 'string' ? c : (c || []).filter(p => p.type === 'text').map(p => p.text).join('');
  return !!stripReminders(text) && !text.trimStart().startsWith('<');
}

function cleanContent(content) {
  if (typeof content === 'string') return stripReminders(content);
  return content.flatMap(p => {
    if (p.type === 'text') { const text = stripReminders(p.text); return text ? [{ ...p, text }] : []; }
    if (p.type === 'tool_use') {
      const input = Object.fromEntries(Object.entries(p.input || {}).map(([k, v]) => [k, typeof v === 'string' ? trim(v, MAX_INPUT_CHARS) : v]));
      return [{ type: 'tool_use', id: p.id, name: p.name, input }];
    }
    if (p.type === 'tool_result') {
      const raw = typeof p.content === 'string' ? p.content
        : (p.content || []).map(x => x.type === 'text' ? x.text : x.type === 'image' ? '[image]' : '').join('');
      return [{ type: 'tool_result', tool_use_id: p.tool_use_id, content: trim(raw, MAX_RESULT_CHARS), ...(p.is_error ? { is_error: true } : {}) }];
    }
    return [];   // thinking, images and anything else
  });
}

const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const out = [];
let prompts = 0;
for (const d of lines) {
  if (d.isSidechain) continue;
  if (isPrompt(d) && ++prompts > Number(count)) break;
  // A user line is either a prompt or tool results; anything else is the
  // harness talking (<task-notification>, <command-name>, …).
  const toolResults = d.type === 'user' && Array.isArray(d.message?.content) && d.message.content.some(p => p.type === 'tool_result');
  const keep = (d.type === 'user' && (isPrompt(d) || toolResults)) || d.type === 'assistant' || (d.type === 'system' && d.subtype === 'away_summary');
  if (!keep) continue;
  const entry = Object.fromEntries(KEEP_FIELDS.filter(k => k in d).map(k => [k, d[k]]));
  if (entry.message) {
    const content = cleanContent(entry.message.content || '');
    if (!content.length) continue;
    const { role, content: _, model, usage, id } = entry.message;
    entry.message = { role, content, ...(id ? { id } : {}), ...(model ? { model } : {}), ...(usage ? { usage } : {}) };
  }
  out.push(entry);
}
// Claude Code's own title for the full session.
const title = lines.filter(d => d.type === 'ai-title' && d.aiTitle).pop();
if (title) out.push({ type: 'ai-title', aiTitle: title.aiTitle, sessionId: title.sessionId });

const id = path.basename(file, '.jsonl');
const project = path.basename(path.dirname(file));
const dest = path.join(__dirname, 'home', '.claude', 'projects', project, `${id}.jsonl`);
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, out.map(l => JSON.stringify(l)).join('\n') + '\n');
console.log(`${dest}: ${Math.min(prompts, Number(count))} prompts, ${out.length} lines, ${fs.statSync(dest).size} bytes`);
