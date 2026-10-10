#!/usr/bin/env node
'use strict';

// Copies the opening of a real Claude Code, Codex or Antigravity session into
// the demo's sample home (demo/home), in that tool's own format. Run by hand
// when changing the samples; the build never touches your real ~/.claude,
// ~/.codex or ~/.gemini.
//
//   node demo/extract.js <session.jsonl> <prompts>
//
// Keeps everything up to the reply to the <prompts>-th thing you typed, and
// trims what a visitor doesn't need to see: harness-injected messages and
// instructions, thinking/reasoning, subagent traffic, bookkeeping lines, and
// the bulk of long tool output. Your OS username is replaced with "demo"
// everywhere, paths and project folder names included.

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_RESULT_CHARS = 2000;
const MAX_INPUT_CHARS = 2000;
const USERNAME = os.userInfo().username;
const ALIAS = 'demo';

const [file, count] = process.argv.slice(2);
if (!file || !(Number(count) > 0)) {
  console.error('usage: node demo/extract.js <session.jsonl> <prompts>');
  process.exit(1);
}
const limit = Number(count);

const trim = (text, max) => text.length <= max ? text : `${text.slice(0, max)}\n…[trimmed for the demo]`;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Also any Linux account the session ran under (WSL, containers): its home
// folder and its name as file owner and group in `ls -l` output.
function anonymize(text) {
  let out = USERNAME ? text.replace(new RegExp(escapeRe(USERNAME), 'gi'), ALIAS) : text;
  const accounts = new Set([...out.matchAll(/\/home\/([a-z_][a-z0-9_-]*)/g)].map(m => m[1]).filter(n => n !== ALIAS));
  for (const name of accounts) {
    const n = escapeRe(name);
    out = out
      .replace(new RegExp(`/home/${n}\\b`, 'g'), `/home/${ALIAS}`)
      .replace(new RegExp(`-home-${n}-`, 'g'), `-home-${ALIAS}-`)
      .replace(new RegExp(`(\\d+ )${n} ${n}( +\\d)`, 'g'), `$1${ALIAS} ${ALIAS}$2`);
  }
  return out;
}
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

// ── Claude Code (~/.claude/projects/<project>/<id>.jsonl) ────────────
const CLAUDE_FIELDS = ['parentUuid', 'isSidechain', 'userType', 'cwd', 'sessionId', 'version', 'gitBranch', 'type', 'subtype', 'content', 'message', 'uuid', 'timestamp'];
const stripReminders = (text) => text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();

// Something the person typed, as opposed to a tool result or harness text.
function isClaudePrompt(d) {
  if (d.type !== 'user' || d.isMeta || !d.message) return false;
  const c = d.message.content;
  const text = typeof c === 'string' ? c : (c || []).filter(p => p.type === 'text').map(p => p.text).join('');
  return !!stripReminders(text) && !text.trimStart().startsWith('<');
}

function cleanClaudeContent(content) {
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

function extractClaude() {
  const out = [];
  let prompts = 0;
  for (const d of lines) {
    if (d.isSidechain) continue;
    if (isClaudePrompt(d) && ++prompts > limit) break;
    // A user line is either a prompt or tool results; anything else is the
    // harness talking (<task-notification>, <command-name>, …).
    const toolResults = d.type === 'user' && Array.isArray(d.message?.content) && d.message.content.some(p => p.type === 'tool_result');
    const keep = (d.type === 'user' && (isClaudePrompt(d) || toolResults)) || d.type === 'assistant' || (d.type === 'system' && d.subtype === 'away_summary');
    if (!keep) continue;
    const entry = Object.fromEntries(CLAUDE_FIELDS.filter(k => k in d).map(k => [k, d[k]]));
    if (entry.message) {
      const content = cleanClaudeContent(entry.message.content || '');
      if (!content.length) continue;
      const { role, model, usage, id } = entry.message;
      entry.message = { role, content, ...(id ? { id } : {}), ...(model ? { model } : {}), ...(usage ? { usage } : {}) };
    }
    out.push(entry);
  }
  // Claude Code's own title for the full session.
  const title = lines.filter(d => d.type === 'ai-title' && d.aiTitle).pop();
  if (title) out.push({ type: 'ai-title', aiTitle: title.aiTitle, sessionId: title.sessionId });

  const project = path.basename(path.dirname(file));
  return { out, prompts, dest: path.join('.claude', 'projects', project, path.basename(file)) };
}

// ── Codex (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) ────────────
// The same markers codex-sessions.js uses to hide injected context.
const CODEX_INJECTED = ['<environment_context>', '<permissions instructions>', '<user_instructions>', '<apps_instructions>', '<plugins_instructions>', '<skills_instructions>', '# AGENTS.md instructions'];
const codexText = (content) => (content || []).map(c => c.text || '').join('');
const isInjected = (text) => CODEX_INJECTED.some(m => text.trimStart().startsWith(m));

function isCodexPrompt(d) {
  const p = d.payload || {};
  if (d.type === 'event_msg' && p.type === 'user_message') return true;
  return d.type === 'response_item' && p.type === 'message' && p.role === 'user' && !isInjected(codexText(p.content));
}

function extractCodex() {
  // A turn shows up both as an event_msg and as a response_item; count by
  // whichever the file has, as the parser does.
  const hasEvents = lines.some(d => d.type === 'event_msg' && d.payload?.type === 'user_message');
  const countsAsPrompt = (d) => isCodexPrompt(d) && (hasEvents ? d.type === 'event_msg' : d.type === 'response_item');
  const out = [];
  let prompts = 0;
  for (const d of lines) {
    const p = d.payload || {};
    if (countsAsPrompt(d) && ++prompts > limit) break;
    if (d.type === 'session_meta') {
      const { id, timestamp, cwd, originator, cli_version, source } = p;
      out.push({ timestamp: d.timestamp, type: d.type, payload: { id, timestamp, cwd, originator, cli_version, source } });
    } else if (d.type === 'turn_context') {
      out.push({ timestamp: d.timestamp, type: d.type, payload: { cwd: p.cwd, model: p.model } });
    } else if (d.type === 'event_msg' && ['user_message', 'agent_message', 'token_count'].includes(p.type)) {
      out.push(d);
    } else if (d.type === 'response_item' && p.type === 'message') {
      if (p.role === 'assistant' || (p.role === 'user' && !isInjected(codexText(p.content)))) out.push(d);
    } else if (d.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(p.type)) {
      const key = p.type === 'function_call' ? 'arguments' : 'input';
      out.push({ ...d, payload: { ...p, [key]: typeof p[key] === 'string' ? trim(p[key], MAX_INPUT_CHARS) : p[key] } });
    } else if (d.type === 'response_item' && ['function_call_output', 'custom_tool_call_output'].includes(p.type)) {
      out.push({ ...d, payload: { ...p, output: typeof p.output === 'string' ? trim(p.output, MAX_RESULT_CHARS) : p.output } });
    }
  }
  const day = path.dirname(file).split(/[\\/]/).slice(-3);   // YYYY, MM, DD
  return { out, prompts, dest: path.join('.codex', 'sessions', ...day, path.basename(file)) };
}

// ── Antigravity (~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl)
const AGY_FIELDS = ['step_index', 'source', 'type', 'status', 'created_at', 'content', 'tool_calls', 'input_tokens', 'cache_read_tokens', 'output_tokens'];
const isAgyPrompt = (d) => d.type === 'USER_INPUT' && d.source === 'USER_EXPLICIT' && typeof d.content === 'string';

function extractAntigravity() {
  const out = [];
  let prompts = 0;
  for (const d of lines) {
    if (isAgyPrompt(d) && ++prompts > limit) break;
    const entry = Object.fromEntries(AGY_FIELDS.filter(k => k in d).map(k => [k, d[k]]));   // drops thinking
    if (isAgyPrompt(d)) {
      // Only what was typed; the metadata blocks around it are the harness.
      const request = d.content.match(/<USER_REQUEST>[\s\S]*?<\/USER_REQUEST>/i);
      if (request) entry.content = request[0];
    } else if (typeof entry.content === 'string' && entry.type !== 'PLANNER_RESPONSE') {
      entry.content = trim(entry.content, MAX_RESULT_CHARS);
    }
    out.push(entry);
  }
  // The folder a conversation ran in comes from cache/last_conversations.json,
  // so the sample carries that mapping along.
  const logs = path.dirname(file);
  const id = path.basename(path.dirname(path.dirname(logs)));
  const agyHome = path.resolve(logs, '..', '..', '..', '..');
  let cwd = '';
  try {
    const last = JSON.parse(fs.readFileSync(path.join(agyHome, 'cache', 'last_conversations.json'), 'utf8'));
    cwd = Object.keys(last).find(k => String(last[k]).toLowerCase() === id.toLowerCase()) || '';
  } catch {}
  return { out, prompts, id, cwd, dest: path.join('.gemini', 'antigravity-cli', 'brain', id, '.system_generated', 'logs', 'transcript.jsonl') };
}

const isCodex = lines.some(d => d.type === 'session_meta');
const isAntigravity = lines.some(d => d.type === 'USER_INPUT' || d.type === 'PLANNER_RESPONSE');
const result = isCodex ? extractCodex() : isAntigravity ? extractAntigravity() : extractClaude();
const { out, prompts, dest: rel } = result;
const dest = path.join(__dirname, 'home', anonymize(rel));
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, anonymize(out.map(l => JSON.stringify(l)).join('\n')) + '\n');
if (isAntigravity && result.cwd) {
  const lastPath = path.join(__dirname, 'home', '.gemini', 'antigravity-cli', 'cache', 'last_conversations.json');
  let last = {};
  try { last = JSON.parse(fs.readFileSync(lastPath, 'utf8')); } catch {}
  last[anonymize(result.cwd)] = result.id;
  fs.mkdirSync(path.dirname(lastPath), { recursive: true });
  fs.writeFileSync(lastPath, `${JSON.stringify(last, null, 2)}\n`);
}
console.log(`${dest}: ${Math.min(prompts, limit)} prompts, ${out.length} lines, ${fs.statSync(dest).size} bytes`);
