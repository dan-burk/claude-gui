'use strict';

// Paths, on-demand install of the embedding library, tool detection and model
// loading. The library lives outside the repo (which may be a read-only global
// install) under ~/.claude-gui so the main app stays zero-dependency.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { createRequire } = require('module');

const BASE_DIR = path.join(os.homedir(), '.claude-gui');
const RUNTIME_DIR = path.join(BASE_DIR, 'embed-runtime');
const MODELS_DIR = path.join(BASE_DIR, 'models');
const INDEX_DIR = path.join(BASE_DIR, 'embeddings');

const MODEL_ID = 'nomic-ai/nomic-embed-text-v1.5';
const MODEL_DTYPE = 'q8';
const MODEL_FILE = 'onnx/model_quantized.onnx';  // what dtype 'q8' resolves to
const MODEL_SIZE_MB = 140;
const DIMS = 768;
const DOC_PREFIX = 'search_document: ';
const QUERY_PREFIX = 'search_query: ';
const PACKAGE = '@huggingface/transformers';
const PACKAGE_VERSION = '3.8.1';
const IS_WIN = process.platform === 'win32';

// Tunables live in embeddings/.env (KEY=value lines, # comments). Tiny
// hand-written parser so the app stays dependency-free.
const ENV_FILE = path.join(__dirname, '.env');

function parseEnv(text) {
  const out = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    const q = value[0];
    if ((q === '"' || q === "'") && value.endsWith(q) && value.length >= 2) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');  // trailing comment on an unquoted value
    out[key] = value;
  }
  return out;
}

function readEnvFile(file = ENV_FILE) {
  try { return parseEnv(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

// Chunks per model call (CLAUDE_GUI_EMBED_BATCH in embeddings/.env), default 1.
function embedBatchSize(env = readEnvFile()) {
  const n = parseInt(env.CLAUDE_GUI_EMBED_BATCH, 10);
  return n > 0 ? n : 1;
}

// `<tool> --version` → {installed, version}. shell on Windows so npm.cmd resolves.
function detectTool(name) {
  return new Promise((resolve) => {
    execFile(name, ['--version'], { shell: IS_WIN, timeout: 5000, windowsHide: true }, (err, stdout) => {
      const version = String(stdout || '').trim().split(/\r?\n/)[0] || null;
      resolve(err || !version ? { installed: false, version: null } : { installed: true, version });
    });
  });
}

function runtimePackageJson() {
  return path.join(RUNTIME_DIR, 'node_modules', ...PACKAGE.split('/'), 'package.json');
}

function runtimeInstalled() {
  try { return JSON.parse(fs.readFileSync(runtimePackageJson(), 'utf8')).version === PACKAGE_VERSION; }
  catch { return false; }
}

function modelDownloaded() {
  return fs.existsSync(path.join(MODELS_DIR, ...MODEL_ID.split('/'), ...MODEL_FILE.split('/')));
}

// npm install the pinned library into RUNTIME_DIR. onLine gets npm's output.
function installRuntime(onLine = () => {}) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(path.join(RUNTIME_DIR, 'package.json'), JSON.stringify({
    name: 'claude-gui-embed-runtime', private: true, version: '1.0.0',
    description: 'On-demand runtime for claude-gui semantic search (safe to delete)',
    dependencies: { [PACKAGE]: PACKAGE_VERSION },
  }, null, 2));
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['install', '--no-audit', '--no-fund', '--omit=dev', '--loglevel=error'], {
      cwd: RUNTIME_DIR, shell: IS_WIN, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    const relay = (chunk) => {
      const text = String(chunk);
      tail = (tail + text).slice(-2000);
      for (const line of text.split(/\r?\n/)) if (line.trim()) onLine(line.trim());
    };
    child.stdout.on('data', relay);
    child.stderr.on('data', relay);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 && runtimeInstalled()) resolve();
      else reject(new Error(`npm install failed (exit ${code}): ${tail.trim().split('\n').slice(-3).join(' ')}`));
    });
  });
}

// Load @huggingface/transformers from RUNTIME_DIR (its CommonJS build).
let lib = null;
function loadLibrary() {
  if (lib) return lib;
  if (!runtimeInstalled()) throw new Error('embedding runtime not installed');
  const req = createRequire(path.join(RUNTIME_DIR, 'package.json'));
  lib = req(PACKAGE);
  lib.env.cacheDir = MODELS_DIR;
  lib.env.allowLocalModels = false;  // model ids are hub ids; files cache in MODELS_DIR
  return lib;
}

// Feature-extraction pipeline for MODEL_ID. onProgress gets transformers'
// progress_callback events ({status, file, progress, ...}). sessionOptions
// pass through to onnxruntime (e.g. {enableCpuMemArena:false} for the
// long-lived server, which only embeds short queries).
async function loadExtractor(onProgress, sessionOptions) {
  const { pipeline } = loadLibrary();
  return pipeline('feature-extraction', MODEL_ID, {
    dtype: MODEL_DTYPE,
    progress_callback: onProgress || undefined,
    session_options: sessionOptions || undefined,
  });
}

// texts → flat Float32Array (texts.length * DIMS), mean-pooled + normalized.
async function embed(extractor, texts, prefix) {
  const out = await extractor(texts.map(t => prefix + t), { pooling: 'mean', normalize: true });
  if (out.dims[out.dims.length - 1] !== DIMS) throw new Error(`unexpected embedding size ${out.dims}`);
  return Float32Array.from(out.data);
}

module.exports = {
  BASE_DIR, RUNTIME_DIR, MODELS_DIR, INDEX_DIR,
  MODEL_ID, MODEL_DTYPE, MODEL_SIZE_MB, DIMS, DOC_PREFIX, QUERY_PREFIX, PACKAGE, PACKAGE_VERSION,
  ENV_FILE, parseEnv, readEnvFile, embedBatchSize,
  detectTool, runtimeInstalled, modelDownloaded, installRuntime, loadLibrary, loadExtractor, embed,
};
