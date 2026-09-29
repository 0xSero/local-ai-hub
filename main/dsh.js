'use strict';
// DeepSeek harness (dsh): spawn `dsh web` against the local endpoint and embed
// it in the renderer webview. Port, settings and workspace registry live under
// ~/.local/state/local-ai-hub/dsh; the user's own dsh state is never touched.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const YAML = require('yaml');

const PORT = Number(process.env.LOCAL_AI_HUB_DSH_PORT || 3090);
const DSH_PROVIDER = 'local-ai-hub';
const HOME = path.join(os.homedir(), '.local', 'state', 'local-ai-hub', 'dsh');

let child = null;
let restarting = false;

const settingsPath = () => path.join(HOME, 'settings.yaml');

// Write (never clobber) the provider block pointing at the endpoint. Same
// YAML-edit contract as local-studio's writeDshSettings.
// Exposed for tests: the same settings writer against an arbitrary path.
const writeSettingsAt = (p, baseUrl, models, defaultModel) => {
  const doc = fs.existsSync(p) && fs.readFileSync(p, 'utf8').trim() ? YAML.parseDocument(fs.readFileSync(p, 'utf8')) : new YAML.Document({});
  if (doc.errors.length) throw new Error(`${p} is not valid YAML; refusing to rewrite it`);
  const provider = {
    displayName: 'Local AI Hub',
    api: 'openai-completions',
    baseURL: `${baseUrl.replace(/\/+$/, '')}/v1`,
    apiKeyEnv: 'LOCAL_AI_HUB_KEY',
    defaultInput: ['text'],
    models: models.map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
      input: ['text'],
    })),
  };
  doc.setIn(['llm-pi-ai', 'providers', DSH_PROVIDER], doc.createNode(provider));
  doc.set('agent-default-model', doc.createNode({ provider: DSH_PROVIDER, model: defaultModel }));
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, doc.toString(), { mode: 0o600 });
  fs.renameSync(tmp, p);
};

const writeSettings = (baseUrl, models, defaultModel) => writeSettingsAt(settingsPath(), baseUrl, models, defaultModel);

const addWorkspace = (dir) => {
  const file = path.join(HOME, 'storages', 'workspace.json');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let doc = {};
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { if (fs.existsSync(file)) return; }
  const ws = doc.tables?.workspaces ?? {};
  if (Object.values(ws).some((w) => w.path === dir)) return;
  const id = require('node:crypto').randomUUID();
  const now = new Date().toISOString();
  doc.unit ??= { name: 'workspace', version: 2 };
  doc.global = { initialized: true, archivedSessionIds: [], ...(doc.global ?? {}), workspaceIds: [...(doc.global?.workspaceIds ?? []), id] };
  doc.tables = { ...doc.tables, workspaces: { ...ws, [id]: { path: dir, title: path.basename(dir), sessionIds: [], createdAt: now, updatedAt: now } } };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
};

const probe = () =>
  new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${PORT}/`, { timeout: 2_000 }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 400 || res.statusCode === 401 || res.statusCode === 403);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });

const logFile = () => path.join(HOME, 'web.log');

// Start `dsh web`. `dshBin` comes from the renderer (resolved via `which dsh`).
// If dsh is missing the promise rejects with a clear message; nothing else is
// installed or modified.
const ensure = async ({ baseUrl, models, defaultModel, cwd, dshBin }) => {
  if (!dshBin || !fs.existsSync(dshBin)) throw new Error('dsh is not installed — install it with: npm i -g @deepseek-ai/dsh (or npx @deepseek-ai/dsh web)');
  writeSettings(baseUrl, models, defaultModel);
  if (child || (await probe())) return { ok: true, url: `http://127.0.0.1:${PORT}/`, detail: child ? 'harness running' : 'something already answers on the dsh port' };
  fs.mkdirSync(cwd, { recursive: true });
  addWorkspace(cwd);
  const env = {
    ...process.env,
    DSH_HOME: HOME,
    LOCAL_AI_HUB_KEY: 'local',
    DSH_TELEMETRY_DISABLED: '1',
    PWD: cwd,
  };
  child = spawn(dshBin, ['web', '--port', String(PORT), '--no-open'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = fs.createWriteStream(logFile(), { flags: 'a', mode: 0o600 });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  child.on('exit', (code) => {
    child = null;
    if (restarting) return;
    // auto-restart up to 5 times in 10 minutes, like local-studio does
    setTimeout(() => {
      if (!child) { restarting = true; ensure({ baseUrl, models, defaultModel, cwd, dshBin }).finally(() => { restarting = false; }); }
    }, 5_000);
  });
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (!child) throw new Error('dsh web exited during startup; see ' + logFile());
    if (await probe()) return { ok: true, url: `http://127.0.0.1:${PORT}/`, detail: 'harness ready' };
  }
  throw new Error(`dsh web did not answer on :${PORT} within 60 s; see ${logFile()}`);
};

const stop = () => {
  if (child) { child.kill('SIGTERM'); child = null; }
};

const status = async () => ({ running: Boolean(child) || (await probe()), port: PORT, url: `http://127.0.0.1:${PORT}/` });

module.exports = { ensure, stop, status, writeSettings, writeSettingsAt, PORT };
