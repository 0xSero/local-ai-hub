'use strict';
// Container lifecycle: download plan, docker run, acceptance, unload.
// One managed container, same contract as omarchy-local-ai/lib/core.sh.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { sh } = require('./registry');

const CONTAINER = process.env.LOCAL_AI_HUB_CONTAINER || 'local-ai-hub';
const PORT = Number(process.env.LOCAL_AI_HUB_PORT || 12434);
const HOME = os.homedir();

const duKB = (dir) => {
  try {
    return Number.parseInt(
      require('node:child_process').execSync(`du -skL ${JSON.stringify(dir)} 2>/dev/null || echo 0`).toString().trim().split(/\s+/)[0],
      10) || 0;
  } catch { return 0; }
};

const mountedBytes = (mounts) => {
  let bytes = 0;
  for (const m of mounts ?? []) {
    if (!m.source || !m.target) continue;
    const src = m.source.startsWith('~/') ? path.join(HOME, m.source.slice(2)) : m.source;
    if (fs.existsSync(src)) bytes += duKB(src) * 1024;
  }
  return bytes;
};

const modelCacheBytes = (repository) => {
  const repo = path.join(HOME, '.cache', 'huggingface', 'hub', `models--${repository.replace(/\//g, '--')}`);
  return duKB(repo) * 1024;
};

// Safety: only mounts inside ~/.cache or the registry checkout are allowed.
const resolveMount = (m, registryDir) => {
  let src = m.source;
  if (src.startsWith('~/')) src = path.join(HOME, src.slice(2));
  else if (!src.startsWith('/')) src = path.join(registryDir, src);
  if (!src.startsWith(path.join(HOME, '.cache')) && !src.startsWith(registryDir) && src !== '/dev/dri/by-path') {
    throw new Error(`registry mount is outside the local boundary: ${src}`);
  }
  return src;
};

const fetchJson = (url, timeoutMs = 5_000) =>
  new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(body) }); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });

const servedModel = async () => {
  const r = await fetchJson(`http://127.0.0.1:${PORT}/v1/models`);
  const id = r.body?.data?.[0]?.id;
  if (!id) throw new Error('endpoint answered without a model id');
  return id;
};

const chatOnce = async (prompt, timeoutMs = 600_000) => {
  const body = JSON.stringify({ model: await servedModel(), messages: [{ role: 'user', content: prompt }], stream: false });
  return new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${PORT}/v1/chat/completions`, { method: 'POST', timeout: timeoutMs, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
};

const acceptModel = async (deadlineS = 7200) => {
  const end = Date.now() + deadlineS * 1000;
  while (Date.now() < end) {
    try { await servedModel(); break; } catch { /* still loading */ }
    const running = await (async () => {
      try { await sh('docker', ['inspect', '-f', '{{.State.Running}}', CONTAINER], { timeout: 5_000 }); return true; } catch { return false; }
    })();
    if (!running) return false;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  try {
    const reply = await chatOnce('Reply with exactly: LOCAL_AI_READY');
    const text = `${reply.choices?.[0]?.message?.content ?? ''} ${reply.choices?.[0]?.message?.reasoning_content ?? ''}`;
    return text.includes('LOCAL_AI_READY');
  } catch { return false; }
};

// docker run argv straight from the recipe. GPU devices are picked by free VRAM.
const runPlan = async (recipe, detected, registryDir) => {
  const backend = recipe.compatibility.acceleratorBackend;
  const count = recipe.compatibility.acceleratorCount;
  const argv = ['run', '--detach', '--name', CONTAINER, '--restart', 'unless-stopped',
    '--label', 'io.local-ai-hub=1', '--label', `io.local-ai-hub.recipe=${recipe.id}`];
  if (backend === 'nvidia') {
    const group = detected.groups.find((g) => g.product === recipe.localProduct);
    const ids = (group?.devices ?? []).sort((a, b) => b.freeMiB - a.freeMiB).slice(0, count).map((d) => d.index).join(',');
    if (!ids) throw new Error('compatible NVIDIA GPUs are busy');
    argv.push('--gpus', `device=${ids}`);
  } else if (recipe.launch.devices.includes('/dev/dri')) {
    argv.push('--device', '/dev/dri:/dev/dri');
  } else if (backend === 'metal') {
    throw new Error('metal recipes run natively on macOS; this build launches docker recipes only');
  }
  argv.push('--publish', `127.0.0.1:${PORT}:${recipe.endpoint.containerPort}`);
  if (recipe.launch.ipc === 'host') argv.push('--ipc', 'host');
  if (recipe.launch.shmSize) argv.push('--shm-size', recipe.launch.shmSize);
  for (const m of recipe.launch.mounts ?? []) {
    if (!m.source || !m.target) continue;
    argv.push('--volume', `${resolveMount(m, registryDir)}:${m.target}${m.read_only ? ':ro' : ''}`);
  }
  for (const [k, v] of Object.entries(recipe.launch.environment ?? {})) argv.push('--env', `${k}=${v}`);
  if (recipe.launch.entrypoint) argv.push('--entrypoint', recipe.launch.entrypoint);
  argv.push(recipe.launch.image);
  argv.push(...(recipe.launch.arguments ?? []));
  return argv;
};

const imageReady = async (image) => {
  try { await sh('docker', ['image', 'inspect', image], { timeout: 10_000 }); return true; } catch { return false; }
};

const modelDownloaded = async (recipe) => {
  if (!recipe.model.downloadBytes) return false;
  const bytes = modelCacheBytes(recipe.model.repository) + mountedBytes(recipe.launch.mounts);
  return bytes * 100 >= recipe.model.downloadBytes * 85;
};

// Download: pull the pinned image, then fetch the exact revision with the
// image's own `hf` CLI (same approach as omarchy-local-ai download_plan_json).
const downloadPlan = (recipe, registryDir) => {
  const fetchArgv = ['run', '--rm', '--label', 'io.local-ai-hub.download=1', '--entrypoint', 'hf'];
  for (const m of recipe.launch.mounts ?? []) {
    if (!m.target || !(m.target === '/models' || m.target.includes('huggingface'))) continue;
    fetchArgv.push('--volume', `${resolveMount(m, registryDir)}:${m.target}`);
  }
  fetchArgv.push(recipe.launch.image, 'download', recipe.model.repository, '--revision', recipe.model.revision);
  return { pull: ['pull', recipe.launch.image], fetch: fetchArgv };
};

const restorePrevious = async (oldName) => {
  try {
    await sh('docker', ['rm', '-f', CONTAINER], { timeout: 30_000 });
  } catch { /* not running */ }
  try {
    await sh('docker', ['rename', oldName, CONTAINER], { timeout: 10_000 });
    await sh('docker', ['start', CONTAINER], { timeout: 30_000 });
  } catch { /* no previous container */ }
};

// Run with acceptance; on failure remove the new container and restore the last one.
const runRecipe = async (recipe, detected, registryDir) => {
  if (!(await modelDownloaded(recipe))) throw new Error('model is not downloaded; download it first');
  if (!(await imageReady(recipe.launch.image))) throw new Error('image is not pulled; download it first');
  let oldRunning = false;
  let hasOld = false;
  const oldName = `${CONTAINER}-previous`;
  try {
    await sh('docker', ['inspect', CONTAINER], { timeout: 5_000 });
    hasOld = true;
    try {
      const st = await sh('docker', ['inspect', '-f', '{{.State.Running}}', CONTAINER], { timeout: 5_000 });
      oldRunning = st.trim() === 'true';
    } catch { /* inspect -f can fail on odd states */ }
    if (oldRunning) await sh('docker', ['stop', CONTAINER], { timeout: 120_000 });
    await sh('docker', ['rename', CONTAINER, oldName], { timeout: 10_000 });
  } catch { hasOld = false; }

  const argv = await runPlan(recipe, detected, registryDir);
  try {
    await sh('docker', argv, { timeout: 120_000 });
    const ok = await acceptModel();
    if (!ok) throw new Error('new model failed acceptance');
    await sh('docker', ['rm', '-f', oldName], { timeout: 30_000 }).catch(() => {});
    return { ok: true, detail: `ready · http://127.0.0.1:${PORT}/v1` };
  } catch (e) {
    await restorePrevious(hasOld ? oldName : null);
    if (hasOld && oldRunning) await sh('docker', ['start', CONTAINER], { timeout: 30_000 }).catch(() => {});
    throw e;
  }
};

const unload = async () => {
  await sh('docker', ['rm', '-f', CONTAINER], { timeout: 30_000 }).catch(() => {});
  return { ok: true, detail: 'unloaded · downloads kept' };
};

module.exports = { CONTAINER, PORT, servedModel, chatOnce, acceptModel, runRecipe, unload, downloadPlan, imageReady, modelDownloaded, modelCacheBytes, runPlan, resolveMount };
