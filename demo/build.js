#!/usr/bin/env node
'use strict';

// Builds the static demo published to danielburkhalter.dev/claude-gui.
//
// The real server runs once, against a throwaway home directory holding the
// sample data in demo/home (laid out like ~/.claude). Every response the page
// can ask for is saved into one data.json, and demo-shim.js answers the page's
// /api calls from it in the browser. Sessions are parsed by the same code users
// install; only the transport is replaced.
//
//   node demo/build.js [outDir]      (default: _site)

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const config = require('./config');

const ROOT = path.join(__dirname, '..');
const SAMPLE_HOME = path.join(__dirname, 'home');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, '_site'));

function write(file, content, mtime) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mtime) fs.utimesSync(file, mtime, mtime);
}

function readLines(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// ── The throwaway home ────────────────────────────────────────────────
function writeHome(home) {
  fs.cpSync(SAMPLE_HOME, home, { recursive: true });

  // A checkout dates every file to the clone, so put each session back at the
  // time it was last active; otherwise Organize treats them all as still open.
  // Memory files take the project's latest session time.
  const projectsDir = path.join(home, '.claude', 'projects');
  for (const dir of fs.readdirSync(projectsDir)) {
    let latest = null;
    for (const file of fs.readdirSync(path.join(projectsDir, dir)).filter(f => f.endsWith('.jsonl'))) {
      const fp = path.join(projectsDir, dir, file);
      const last = readLines(fp).map(d => d.timestamp).filter(Boolean).pop();
      if (!last) continue;
      fs.utimesSync(fp, new Date(last), new Date(last));
      if (!latest || new Date(last) > latest) latest = new Date(last);
    }
    const memDir = path.join(projectsDir, dir, 'memory');
    if (latest && fs.existsSync(memDir)) {
      for (const file of fs.readdirSync(memDir)) fs.utimesSync(path.join(memDir, file), latest, latest);
    }
  }

  // Plugins are registered by absolute install path, which only exists now.
  const cache = path.join(home, '.claude', 'plugins', 'cache');
  const plugins = {}, markets = {};
  const subdirs = (p) => { try { return fs.readdirSync(p).filter(n => fs.statSync(path.join(p, n)).isDirectory()); } catch { return []; } };
  for (const marketplace of subdirs(cache)) {
    if (config.marketplaces[marketplace]) markets[marketplace] = { source: { source: 'github', repo: config.marketplaces[marketplace] } };
    for (const name of subdirs(path.join(cache, marketplace))) {
      for (const version of subdirs(path.join(cache, marketplace, name))) {
        plugins[`${name}@${marketplace}`] = [{
          scope: 'user', installPath: path.join(cache, marketplace, name, version), version,
          installedAt: '2026-09-15T16:20:00.000Z', lastUpdated: '2026-09-15T16:20:00.000Z',
        }];
      }
    }
  }
  const settings = { ...config.settings, enabledPlugins: Object.fromEntries(Object.keys(plugins).map(k => [k, true])) };
  write(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins }, null, 2));
  write(path.join(home, '.claude', 'plugins', 'known_marketplaces.json'), JSON.stringify(markets, null, 2));
  write(path.join(home, '.claude', 'settings.json'), JSON.stringify(settings, null, 2));
}

// The server keeps pins and export folders in claude-gui-data.json next to
// index.js, so it runs from a copy: a build on your own machine must never read
// (or snapshot) your real pins or ChatGPT export.
function copyApp(appDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const entry of ['package.json', ...pkg.files]) {
    fs.cpSync(path.join(ROOT, entry), path.join(appDir, entry), { recursive: true });
  }
  write(path.join(appDir, 'claude-gui-data.json'), JSON.stringify({ pins: config.pins }, null, 2));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer().once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

// ── Snapshot every GET the page makes ─────────────────────────────────
async function snapshot(appDir, home) {
  const port = await freePort();
  const server = spawn(process.execPath, [path.join(appDir, 'index.js'), String(port)], {
    env: {
      ...process.env,
      HOME: home, USERPROFILE: home,   // os.homedir() on Linux/macOS and on Windows
      CODEX_HOME: path.join(home, '.codex'),
      ANTIGRAVITY_HOME: path.join(home, '.gemini', 'antigravity-cli'),
      CLAUDE_GUI_NO_BROWSER: '1',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  let exited = false;
  server.on('exit', () => { exited = true; });

  const get = async (p) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`);
    if (!r.ok) throw new Error(`GET ${p}: HTTP ${r.status} ${await r.text()}`);
    return r.json();
  };

  try {
    let sessions;
    for (let i = 0; !sessions; i++) {
      if (exited) throw new Error('claude-gui exited before it started serving');
      if (i > 100) throw new Error('claude-gui did not start within 10s');
      try { sessions = await get('/api/sessions'); } catch { await new Promise(r => setTimeout(r, 100)); }
    }

    // Exactly the sample sessions, or something else answered on this port.
    const projectsDir = path.join(home, '.claude', 'projects');
    const claudeIds = fs.readdirSync(projectsDir)
      .flatMap(dir => fs.readdirSync(path.join(projectsDir, dir)).filter(f => f.endsWith('.jsonl')).map(f => path.basename(f, '.jsonl')));
    const codexDir = path.join(home, '.codex', 'sessions');
    const codexIds = fs.existsSync(codexDir)
      ? fs.readdirSync(codexDir, { recursive: true }).filter(f => f.endsWith('.jsonl'))
        .map(f => readLines(path.join(codexDir, f)).find(d => d.type === 'session_meta').payload.id)
      : [];
    const brainDir = path.join(home, '.gemini', 'antigravity-cli', 'brain');
    const antigravityIds = fs.existsSync(brainDir) ? fs.readdirSync(brainDir) : [];
    const expected = [...claudeIds, ...codexIds, ...antigravityIds].sort();
    const got = sessions.map(s => s.id).sort();
    if (!expected.length || JSON.stringify(got) !== JSON.stringify(expected)) {
      throw new Error(`expected sessions ${expected.join(', ') || '(none in demo/home)'}, got ${got.join(', ') || 'none'}`);
    }

    const data = { sessions, messages: {}, projectIndex: {}, memoryFiles: {}, pluginSkills: {} };
    for (const s of sessions) data.messages[s.id] = await get(`/api/sessions/${s.id}/messages?provider=${s.provider}`);
    for (const dir of new Set(sessions.filter(s => s.provider === 'claude').map(s => s.projectDir))) {
      data.projectIndex[dir] = (await get(`/api/project-index?project=${encodeURIComponent(dir)}`)).entries;
    }
    data.settings = await get('/api/settings');
    data.pins = (await get('/api/pins')).pins;
    data.memory = await get('/api/memory');
    for (const m of data.memory) {
      data.memoryFiles[m.key] = await get(`/api/memory/files?provider=${m.provider}&project=${encodeURIComponent(m.projectDir)}`);
    }
    data.plugins = await get('/api/plugins');
    for (const p of data.plugins) data.pluginSkills[p.id] = await get(`/api/plugins/skills?id=${encodeURIComponent(p.id)}`);
    return data;
  } finally {
    server.kill();
  }
}

// The server finds a project's path by matching its folder name against the
// disk. Those paths don't exist here, so use the path a session recorded, or
// decode the name the way Claude Code encoded it (C--Users-x → C:\Users\x).
function displayPath(projectDir, sessions) {
  const owner = sessions.find(s => s.projectDir === projectDir);
  if (owner && owner.cwd) return owner.cwd;
  const windows = /^([A-Za-z])--(.+)$/.exec(projectDir);
  if (windows) return `${windows[1].toUpperCase()}:\\${windows[2].replace(/-/g, '\\')}`;
  return projectDir.replace(/-/g, '/');
}

// ── Assemble the site ─────────────────────────────────────────────────
async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-gui-demo-'));
  try {
    const home = path.join(tmp, 'home');
    const appDir = path.join(tmp, 'app');
    writeHome(home);
    copyApp(appDir);
    const data = await snapshot(appDir, home);
    for (const m of data.memory) m.path = displayPath(m.projectDir, data.sessions);
    data.organized = config.organized;

    // The build machine's temp folder must not appear in the page. It shows up
    // raw and, inside JSON strings, with backslashes escaped.
    const json = JSON.stringify(data);
    if ([tmp, JSON.stringify(tmp).slice(1, -1)].some(p => json.includes(p))) {
      throw new Error('data.json contains a path from the build machine');
    }

    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const head = '<title>Agent Sessions</title>';
    if (!html.includes(head)) throw new Error(`public/index.html no longer contains ${head}`);
    // Analytics are the demo's alone, shared with the rest of danielburkhalter.dev;
    // the installed app never loads them.
    const page = html.replace(head, [
      '<title>Claude GUI demo</title>',
      '  <meta name="description" content="Live demo of claude-gui, a lightweight browser for Claude Code sessions, with sample data.">',
      '  <!-- Google tag (gtag.js); only reports from the live site, so local dev doesn\'t pollute analytics -->',
      '  <script async src="https://www.googletagmanager.com/gtag/js?id=G-3HK7FW9Y6N"></script>',
      '  <script>',
      '    window.dataLayer = window.dataLayer || [];',
      '    function gtag(){dataLayer.push(arguments);}',
      "    if (location.hostname === 'danielburkhalter.dev') {",
      "      gtag('js', new Date());",
      "      gtag('config', 'G-3HK7FW9Y6N');",
      '    }',
      '  </script>',
      '  <script src="demo-shim.js"></script>',
    ].join('\n'));

    fs.rmSync(OUT, { recursive: true, force: true });
    write(path.join(OUT, 'index.html'), page);
    write(path.join(OUT, 'data.json'), json);
    fs.copyFileSync(path.join(__dirname, 'demo-shim.js'), path.join(OUT, 'demo-shim.js'));
    console.log(`Demo built in ${OUT}: ${data.sessions.length} sessions, ${data.memory.length} memory projects, ${data.plugins.length} plugins`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
