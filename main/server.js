'use strict';
// Web mode: serve the same hub UI over HTTP (tailnet). Headless hosts run
// `node main/server.js` with no display; the renderer talks to the same IPC
// surface, backed by a fetch shim instead of the Electron bridge.

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
// http is used both for the server and the dsh proxy

const registry = require('./registry');
const statsMod = require('./stats');
const container = require('./container');
const dsh = require('./dsh');

const PORT = Number(process.env.LOCAL_AI_HUB_WEB_PORT || 43000);
const STATE_DIR = path.join(os.homedir(), '.local', 'state', 'local-ai-hub');
const ACTIVE_FILE = path.join(STATE_DIR, 'active.json');
const WORK_DIR = path.join(os.homedir(), 'local-ai-hub', 'workspace');

let detectedGroups = [];

const which = (bin) =>
  new Promise((resolve) => {
    execFile('which', [bin], (err, stdout) => resolve(err ? null : String(stdout).trim()));
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

const routes = {
  snapshot,
  'sync-registry': async () => { const info = await registry.syncRegistry(); return snapshot(); },
  load: async (arg) => {
    const recipeId = typeof arg === 'string' ? arg : arg?.recipeId;
    const recipe = registry.buildRecipe(recipeId, { groups: detectedGroups });
    const res = await container.runRecipe(recipe, { groups: detectedGroups }, registry.REGISTRY_DIR);
    writeActive({ recipeId, recipe, port: container.PORT, startedAt: new Date().toISOString() });
    return res;
  },
  unload: async () => {
    const res = await container.unload();
    fs.rmSync(ACTIVE_FILE, { force: true });
    return res;
  },
  download: async (arg) => {
    const recipeId = typeof arg === 'string' ? arg : arg?.recipeId;
    const recipe = registry.buildRecipe(recipeId, { groups: detectedGroups });
    const plan = container.downloadPlan(recipe, registry.REGISTRY_DIR);
    await new Promise((resolve, reject) => execFile('docker', plan.pull, { timeout: 3_600_000 }, (e) => e ? reject(e) : resolve()));
    if (!(await container.modelDownloaded(recipe))) {
      await new Promise((resolve, reject) => execFile('docker', plan.fetch, { timeout: 3_600_000 * 4 }, (e) => e ? reject(e) : resolve()));
    }
    if (!(await container.modelDownloaded(recipe))) throw new Error('download finished but the registry-declared files are incomplete');
    return { ok: true, detail: `downloaded · ${recipe.model.name}` };
  },
  'probe-endpoint': async () => ({ model: await container.servedModel() }),
  'open-dsh': async ({ cwd }) => {
    const active = readActive();
    if (!active) throw new Error('load a model first');
    let served;
    try { served = await container.servedModel(); } catch { throw new Error('endpoint is not answering yet'); }
    const recipe = active.recipe ?? {};
    const dshBin = await which('dsh');
    return dsh.ensure({
      baseUrl: `http://127.0.0.1:${container.PORT}`,
      models: [{ id: served, name: recipe.model?.name ?? served, contextWindow: recipe.serving?.configuredMaxContextTokens ?? null }],
      defaultModel: served,
      cwd: cwd || WORK_DIR,
      dshBin,
    });
  },
  'stop-dsh': () => dsh.stop(),
};

const SHIM = `
window.hub = {
  snapshot: () => hubCall('snapshot'),
  syncRegistry: () => hubCall('sync-registry'),
  load: (id) => hubCall('load', id),
  unload: () => hubCall('unload'),
  download: (id) => hubCall('download', id),
  probeEndpoint: () => hubCall('probe-endpoint'),
  openDsh: (cwd) => hubCall('open-dsh', cwd ? { cwd } : {}),
  stopDsh: () => hubCall('stop-dsh'),
};
async function hubCall(route, arg) {
  const res = await fetch('/rpc/' + route, {
    method: arg === undefined ? 'GET' : 'POST',
    body: arg === undefined ? undefined : JSON.stringify(arg),
    headers: { 'Content-Type': 'application/json' },
  });
  return res.json();
}`;

const renderPage = () => {
  const html = fs.readFileSync(path.join(__dirname, 'renderer', 'index.html'), 'utf8');
  // webview tag is electron-only; in a browser the harness opens in an iframe.
  // Inject the RPC shim before ui.js; ui.js itself ships unmodified.
  return html.replace('<script src="ui.js"></script>', `<script>${SHIM}</script><script src="ui.js"></script>`);
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const ip = req.socket.remoteAddress;
  // loopback and tailnet (100.64.0.0/10) only
  if (!/^127\.0\.0\.1$|^::1$|^::ffff:127\.0\.0\.1$|^::ffff:100\./.test(ip ?? '') && !(ip ?? '').startsWith('100.')) {
    res.writeHead(403).end('forbidden');
    return;
  }
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(renderPage());
    return;
  }
  if (req.method === 'GET' && url.pathname === '/ui.js') {
    const js = fs.readFileSync(path.join(__dirname, 'renderer', 'ui.js'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(js);
    return;
  }
  if (req.method === 'GET' && url.pathname.startsWith('/dsh/')) {
    // reverse-proxy the dsh web UI onto this origin so the iframe is same-origin
    // and the token cookie applies cleanly.
    const target = `http://127.0.0.1:${dsh.PORT}${url.pathname.replace(/^\/dsh/, '')}${url.search}`;
    proxyWeb(req, res, target);
    return;
  }
  // dsh's client uses absolute paths (/api/..., /assets/...); anything the hub
  // does not own goes to dsh so the embedded UI works.
  if (!['/', '/ui.js'].includes(url.pathname) && !url.pathname.startsWith('/rpc/') && !url.pathname.startsWith('/dsh/')) {
    proxyWeb(req, res, `http://127.0.0.1:${dsh.PORT}${url.pathname}${url.search}`);
    return;
  }
  const m = url.pathname.match(/^\/rpc\/([\w-]+)$/);
  if (m && routes[m[1]]) {
    const arg = req.method === 'POST' ? await readBody(req) : undefined;
    try {
      // POST bodies: {recipeId} for load/download, {cwd} for open-dsh
      const data = await routes[m[1]](arg);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, data }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, error: e.message ?? String(e) }));
    }
    return;
  }
  res.writeHead(404).end('not found');
});

const readBody = (req) => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', () => { try { resolve(body ? JSON.parse(body) : undefined); } catch (e) { reject(e); } });
  req.on('error', reject);
});

// Streaming proxy for the dsh web UI (http, loopback target). Handles the
// websocket upgrade too — the workspace panel uses one.
const proxyWeb = (req, res, target) => {
  const u = new URL(target);
  const headers = { ...req.headers, host: u.host };
  delete headers['origin'];
  delete headers['referer'];
  if (headers.upgrade === 'websocket') {
    const key = headers['sec-websocket-key'];
    const preq = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: req.method, headers });
    preq.on('upgrade', (pres, socket) => {
      const lines = [`HTTP/1.1 101 Switching Protocols`];
      for (const [k, v] of Object.entries(pres.headers)) lines.push(`${k}: ${v}`);
      res.socket.write(lines.join('\r\n') + '\r\n\r\n');
      res.socket.pipe(socket);
      socket.pipe(res.socket);
    });
    preq.on('error', () => { try { res.writeHead(502).end('dsh is not running'); } catch {} });
    preq.end();
    return;
  }
  const preq = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: req.method, headers }, (pres) => {
    res.writeHead(pres.statusCode ?? 502, pres.headers);
    pres.pipe(res);
  });
  preq.on('error', () => { try { res.writeHead(502).end('dsh is not running'); } catch {} });
  req.pipe(preq);
};

server.listen(PORT, '0.0.0.0', () => console.log(`local-ai-hub web on http://0.0.0.0:${PORT} (loopback + tailnet only)`));
