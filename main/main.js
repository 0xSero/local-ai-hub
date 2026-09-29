'use strict';
// Local AI Hub — main process.
// Wires: registry sync, machine stats, container lifecycle, dsh embedding.

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const registry = require('./registry');
const statsMod = require('./stats');
const container = require('./container');
const dsh = require('./dsh');

const STATE_DIR = path.join(os.homedir(), '.local', 'state', 'local-ai-hub');
const ACTIVE_FILE = path.join(STATE_DIR, 'active.json');
const WORK_DIR = path.join(os.homedir(), 'local-ai-hub', 'workspace');

let detectedGroups = []; // latest hardware groups, reused when running recipes

const which = (bin) =>
  new Promise((resolve) => {
    execFile(process.platform === 'win32' ? 'where' : 'which', [bin], (err, stdout) => resolve(err ? null : String(stdout).trim()));
  });

const readActive = () => {
  try { return JSON.parse(fs.readFileSync(ACTIVE_FILE, 'utf8')); } catch { return null; }
};

const writeActive = (doc) => {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(ACTIVE_FILE, JSON.stringify(doc, null, 2), { mode: 0o600 });
};

const snapshot = async () => {
  const stats = await statsMod.stats(registry.REGISTRY_DIR, 'local-ai-hub');
  detectedGroups = stats.groups;
  const active = readActive();
  stats.activeRecipeId = active?.recipeId ?? '';
  stats.modelRunning = stats.modelRunning && Boolean(active);
  let models = [];
  let registryInfo = { path: registry.REGISTRY_DIR, recipeCount: 0, totalRecipeCount: 0, synced: false };
  if (fs.existsSync(registry.REGISTRY_DIR + '/index.json') || fs.existsSync(registry.REGISTRY_DIR + '/data/registry/index/recipes.json')) {
    const info = registry.loadRegistry();
    registryInfo = { ...info, synced: true, totalRecipeCount: info.recipes };
    const enriched = registry.recipesForHardware({ groups: stats.groups, activeRecipeId: stats.activeRecipeId });
    const downloads = await Promise.all(enriched.map(async (r) => ({
      id: r.id,
      imageDownloaded: await container.imageReady(r.launch.image).catch(() => false),
      modelDownloaded: await container.modelDownloaded(r).catch(() => false),
    })));
    const dlById = new Map(downloads.map((d) => [d.id, d]));
    models = enriched.map((r) => ({
      ...r,
      downloaded: (dlById.get(r.id)?.imageDownloaded ?? false) && (dlById.get(r.id)?.modelDownloaded ?? false),
      active: r.id === stats.activeRecipeId,
    }));
  }
  return { stats, registry: registryInfo, models, active, dsh: await dsh.status() };
};

const createWindow = () => {
  const win = new BrowserWindow({
    width: 1180,
    height: 800,
    title: 'Local AI Hub',
    backgroundColor: '#fcfcfc',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  return win;
};

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  dsh.stop();
  if (process.platform !== 'darwin') app.quit();
});

// --- IPC -------------------------------------------------------------------

const handle = (channel, fn) => ipcMain.handle(channel, async (_event, ...args) => {
  try { return { ok: true, data: await fn(...args) }; }
  catch (e) { return { ok: false, error: e.message ?? String(e) }; }
});

handle('snapshot', () => snapshot());

handle('sync-registry', async () => {
  const info = await registry.syncRegistry();
  return snapshot();
});

handle('load', async (recipeId) => {
  const recipe = registry.buildRecipe(recipeId, { groups: detectedGroups });
  const res = await container.runRecipe(recipe, { groups: detectedGroups }, registry.REGISTRY_DIR);
  writeActive({ recipeId, recipe, port: container.PORT, startedAt: new Date().toISOString() });
  return res;
});

handle('unload', async () => {
  const res = await container.unload();
  fs.rmSync(ACTIVE_FILE, { force: true });
  return res;
});

handle('download', async (recipeId) => {
  const recipe = registry.buildRecipe(recipeId, { groups: detectedGroups });
  const plan = container.downloadPlan(recipe, registry.REGISTRY_DIR);
  const argvPull = ['docker', ...plan.pull];
  await new Promise((resolve, reject) => execFile(argvPull[0], argvPull.slice(1), { timeout: 3_600_000, maxBuffer: 8 * 1024 * 1024 }, (e, so) => e ? reject(e) : resolve(so)));
  const already = await container.modelDownloaded(recipe);
  if (!already) {
    const argvFetch = ['docker', ...plan.fetch];
    await new Promise((resolve, reject) => execFile(argvFetch[0], argvFetch.slice(1), { timeout: 3_600_000 * 4, maxBuffer: 8 * 1024 * 1024 }, (e, so) => e ? reject(e) : resolve(so)));
  }
  if (!(await container.modelDownloaded(recipe))) throw new Error('download finished but the registry-declared files are incomplete');
  return { ok: true, detail: `downloaded · ${recipe.model.name}` };
});

// Acceptance probe against the endpoint (also what the Load button polls).
handle('probe-endpoint', async () => {
  const model = await container.servedModel();
  return { model };
});

handle('open-dsh', async ({ cwd }) => {
  const active = readActive();
  if (!active) throw new Error('load a model first');
  let served;
  try { served = await container.servedModel(); } catch { throw new Error('endpoint is not answering yet'); }
  const recipe = active.recipe ?? {};
  const models = [{
    id: served,
    name: recipe.model?.name ?? served,
    contextWindow: recipe.serving?.configuredMaxContextTokens ?? null,
  }];
  const dshBin = await which('dsh');
  const res = await dsh.ensure({
    baseUrl: `http://127.0.0.1:${container.PORT}`,
    models,
    defaultModel: served,
    cwd: cwd || WORK_DIR,
    dshBin,
  });
  return res; // { ok, url, detail }
});

handle('stop-dsh', () => dsh.stop());

// Open external links in the real browser instead of the webview.
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
});
