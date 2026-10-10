'use strict';

// Stands in for the claude-gui server on the static demo. public/index.html
// talks to /api/* exactly as it does locally; this answers those calls from
// data.json (a snapshot the real server produced from the sample sessions, see
// build.js). Changes live in memory only, so a reload starts over. What needs
// your own machine (export folders, opening files) explains that instead.

(() => {
  const realFetch = window.fetch.bind(window);
  const INSTALL_URL = 'https://github.com/dan-burk/claude-gui#install';
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const MEMORY_NAME_RE = /^[A-Za-z0-9._-]+\.md$/;

  let db;
  const ready = realFetch(new URL('data.json', document.baseURI))
    .then(r => { if (!r.ok) throw new Error(`data.json: HTTP ${r.status}`); return r.json(); })
    .then(d => { db = d; });

  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  const fail = (message, status = 400) => json({ error: message }, status);
  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return realFetch(input, init);
    await ready;
    const method = (init.method || 'GET').toUpperCase();
    let body = {};
    try { body = typeof init.body === 'string' ? JSON.parse(init.body || '{}') : {}; } catch {}
    try { return await route(method, url.pathname, url.searchParams, body); }
    catch (e) { return fail(e.message, 500); }
  };

  async function route(method, pathname, q, body) {
    if (method === 'GET' && pathname === '/api/sessions') return json(db.sessions);
    if (method === 'POST' && pathname === '/api/refresh') { await wait(300); return json(db.sessions); }
    if (method === 'GET' && pathname === '/api/search') return json(search(q.get('q')));

    const messages = /^\/api\/sessions\/([0-9a-f-]{36})\/messages$/.exec(pathname);
    if (method === 'GET' && messages) {
      const list = db.messages[messages[1]];
      return list ? json(list) : fail('Session not found', 404);
    }
    if (method === 'DELETE' && pathname.startsWith('/api/sessions/')) return deleteSession(pathname.split('/').pop());

    if (method === 'GET' && pathname === '/api/settings') return json({ ...db.settings });
    if (method === 'PATCH' && pathname === '/api/settings') return saveSettings(body);

    if (method === 'GET' && pathname === '/api/pins') return json({ pins: db.pins });
    if (method === 'PUT' && pathname === '/api/pins') {
      db.pins = Array.isArray(body.pins) ? body.pins.filter(x => typeof x === 'string') : [];
      return json({ pins: db.pins });
    }

    if (method === 'GET' && pathname === '/api/memory') return json(db.memory);
    if (pathname === '/api/memory/files' || pathname === '/api/memory/file') return memory(method, q, body);

    if (method === 'GET' && pathname === '/api/project-index') return json(projectIndex(q.get('project') || ''));
    if (method === 'GET' && pathname === '/api/organize/pending') {
      return json({ pending: pendingSessions(q.get('project') || '', q.get('force') === '1').length });
    }
    if (method === 'POST' && pathname === '/api/organize') return organize(String(body.project || ''), body.force === true, String(body.only || ''));
    if (method === 'POST' && pathname === '/api/prune') {
      await wait(1200);   // the real one asks Claude; nothing in the samples is clutter
      return json({ candidates: [] });
    }

    if (method === 'GET' && pathname === '/api/plugins') return json(db.plugins);
    if (method === 'GET' && pathname === '/api/plugins/skills') {
      const skills = db.pluginSkills[q.get('id') || ''];
      return skills ? json(skills) : fail('plugin not found');
    }
    if (method === 'POST' && pathname === '/api/plugins/open') {
      notice('Opening files in your editor needs the installed app');
      return fail('Opening files needs the installed app', 500);
    }

    return new Response('Not found', { status: 404 });
  }

  // ── Search: same rules as the server ──────────────────────────────
  // Only what was said is searched: prompts and replies, not tool calls or
  // their output.
  function spokenText(id) {
    return (db.messages[id] || [])
      .filter(m => m.type === 'turn')
      .flatMap(m => m.parts.filter(p => p.kind === 'text').map(p => p.text))
      .join('\n');
  }
  const cleanSnippet = (text) => text
    .replace(/[─-▟]+/g, ' ')
    .replace(/([^\w\s])\1{3,}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  function makeSnippet(text, idx, qLen) {
    const start = Math.max(0, idx - 80);
    const end = Math.min(text.length, idx + qLen + 160);
    return (start > 0 ? '…' : '') + cleanSnippet(text.slice(start, end)) + (end < text.length ? '…' : '');
  }
  function search(raw) {
    const query = String(raw || '').trim().toLowerCase();
    const out = {};
    if (!query) return out;
    for (const s of db.sessions) {
      const text = spokenText(s.id);
      const i = text.toLowerCase().indexOf(query);
      if (i >= 0) out[s.key || s.id] = makeSnippet(text, i, query.length);
    }
    return out;
  }

  // ── Sessions ──────────────────────────────────────────────────────
  function deleteSession(id) {
    if (!UUID_RE.test(id)) return fail('invalid session id');
    const before = db.sessions.length;
    db.sessions = db.sessions.filter(s => s.id !== id);
    if (db.sessions.length === before) return json({ success: false }, 404);
    delete db.messages[id];
    db.pins = db.pins.filter(p => p !== id);
    for (const dir of Object.keys(db.projectIndex)) {
      db.projectIndex[dir] = db.projectIndex[dir].filter(e => e.id !== id);
      for (const e of db.projectIndex[dir]) e.cites = (e.cites || []).filter(c => c !== id);
    }
    notice('Deleted from this demo only. Reload to get it back');
    return json({ success: true });
  }

  function saveSettings(body) {
    for (const [field, label] of [['chatgptExportPath', 'ChatGPT'], ['claudeExportPath', 'Claude']]) {
      if (String(body[field] || '').trim() && body[field] !== db.settings[field]) {
        return fail(`The demo can't read folders on your computer. Install claude-gui to browse your ${label} export.`);
      }
    }
    const days = Number(body.cleanupPeriodDays);
    if (Number.isFinite(days) && days >= 1) db.settings.cleanupPeriodDays = Math.round(days);
    return json({ ...db.settings });
  }

  // ── Memory ────────────────────────────────────────────────────────
  function memory(method, q, body) {
    const provider = (method === 'GET' ? q.get('provider') : body.provider) || 'claude';
    const project = method === 'GET' ? q.get('project') : body.project;
    const entry = db.memory.find(m => m.provider === provider && (provider !== 'claude' || m.projectDir === project));
    if (!entry) return fail('no memory for project', method === 'GET' ? 500 : 400);
    const files = db.memoryFiles[entry.key];
    if (method === 'GET') return json(files);

    const name = body.name;
    if (typeof name !== 'string' || name.includes('..') || !MEMORY_NAME_RE.test(name)) return fail('invalid file name');
    const i = files.findIndex(f => f.name === name);
    if (method === 'PUT') {
      if (typeof body.content !== 'string') return fail('invalid content');
      const file = { name, content: body.content, sizeBytes: new Blob([body.content]).size, mtime: Date.now() };
      if (i >= 0) files[i] = file; else files.push(file);
    } else if (method === 'DELETE') {
      if (i < 0) return fail('file not found');
      files.splice(i, 1);
    } else {
      return new Response('Not found', { status: 404 });
    }
    entry.fileCount = files.length;
    entry.sizeBytes = files.reduce((n, f) => n + f.sizeBytes, 0);
    entry.mtime = Date.now();
    notice('Saved in this demo only. Your files are untouched');
    return json({ ok: true });
  }

  // ── Organize: replays the pre-generated answers in sessions.js ────
  function projectIndex(project) {
    const entries = [...(db.projectIndex[project] || [])]
      .sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));
    const local = new Set(entries.map(e => e.id));
    const resolved = {};
    for (const [dir, list] of Object.entries(db.projectIndex)) {
      for (const e of list) {
        if (local.has(e.id) || !entries.some(x => (x.cites || []).includes(e.id))) continue;
        resolved[e.id] = { title: e.title, tags: e.tags, summary: e.summary, date: e.date, projectDir: dir };
      }
    }
    return { entries, resolved };
  }

  function pendingSessions(project, force, only) {
    const indexed = new Set((db.projectIndex[project] || []).filter(e => e.summary).map(e => e.id));
    return db.sessions
      .filter(s => s.provider === 'claude' && s.projectDir === project)
      .filter(s => only ? s.id === only : force || !indexed.has(s.id))
      .sort((a, b) => (a.lastTs || '').localeCompare(b.lastTs || ''));
  }

  function classify(project, s) {
    const list = db.projectIndex[project] || (db.projectIndex[project] = []);
    const answer = db.organized[s.id] || list.find(e => e.id === s.id);
    if (!answer) return { id: s.id, skipped: 'no saved answer in the demo' };
    const entry = {
      id: s.id, date: (s.firstTs || s.lastTs).slice(0, 10),
      title: answer.title, summary: answer.summary, tags: answer.tags, cites: answer.cites || [],
    };
    db.projectIndex[project] = [...list.filter(e => e.id !== s.id), entry];
    s.title = entry.title;
    return { id: s.id, title: entry.title, summary: entry.summary, tags: entry.tags, cites: entry.cites };
  }

  function organize(project, force, only) {
    if (!db.sessions.some(s => s.projectDir === project)) return fail('project not found', 404);
    const candidates = pendingSessions(project, force, only);
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (event) => controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
        const classified = [], skipped = [];
        for (let i = 0; i < candidates.length; i++) {
          const index = i + 1, total = candidates.length;
          send({ phase: 'start', index, total, id: candidates[i].id });
          await wait(1100);
          const result = classify(project, candidates[i]);
          (result.skipped ? skipped : classified).push(result);
          send({ phase: 'done', index, total, ...result });
        }
        send({ phase: 'complete', classified, skipped, failed: [] });
        controller.close();
      },
    });
    return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } });
  }

  // ── Demo badge ────────────────────────────────────────────────────
  let badgeText, noticeTimer;
  const BADGE_TEXT = 'Live demo. Changes aren’t saved';

  function notice(message) {
    if (!badgeText) return;
    badgeText.textContent = message;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { badgeText.textContent = BADGE_TEXT; }, 3500);
  }

  document.addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style');
    // Shown at 80% on desktop so a visitor sees more of a session at once. The
    // app's 100% heights follow the zoomed viewport, so it still fills the window.
    style.textContent = `
      @media (min-width: 900px) { html { zoom: 0.8; } }
      .demo-badge { position: fixed; right: 16px; bottom: 16px; z-index: 1000; display: flex; align-items: center; gap: 10px;
        max-width: calc(100vw - 32px); padding: 8px 10px 8px 14px; border: 1px solid var(--border2); border-radius: 999px;
        background: var(--surface); color: var(--text2); font: 12px/1.3 system-ui, sans-serif; box-shadow: 0 4px 16px rgba(0,0,0,.25); }
      .demo-badge a { flex: none; padding: 4px 10px; border-radius: 999px; background: var(--accent); color: #fff; font-weight: 600; text-decoration: none; }
      .demo-badge a:hover { background: var(--accent-hi); }
      .demo-badge a:focus-visible { outline: 2px solid var(--accent-hi); outline-offset: 2px; }
    `;
    document.head.appendChild(style);
    const badge = document.createElement('div');
    badge.className = 'demo-badge';
    badge.setAttribute('role', 'status');
    badgeText = document.createElement('span');
    badgeText.textContent = BADGE_TEXT;
    const link = document.createElement('a');
    link.href = INSTALL_URL;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'Install ↗';
    badge.append(badgeText, link);
    document.body.appendChild(badge);
  });
})();
