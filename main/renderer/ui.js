'use strict';
/* global hub */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const gb = (b) => (b ? `${(b / 1073741824).toFixed(b / 1073741824 >= 100 ? 0 : 1)} GB` : '—');
const gi = (b) => (b ? `${Math.round(b / 1073741824)} GB` : '—');

const setStatus = (msg, err = false) => {
  const el = $('status');
  el.textContent = msg || '';
  el.className = err ? 'err' : '';
};

const kv = (rows) => rows.map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td>${v}</td></tr>`).join('');

const stateTag = (s) => {
  const cls = s.ready ? 'ok' : s.running ? 'warn' : '';
  const label = s.ready ? 'ready' : s.running ? 'loading' : 'stopped';
  return `<span class="tag ${cls}">${label}</span>`;
};

const renderStats = (stats) => {
  $('hostline').textContent = `${stats.host} · ${stats.platform}/${stats.arch} · ${stats.cpus} cores`;
  const gpu = stats.groups.map((g) =>
    `${esc(g.product)} ×${g.count} (${gi(g.memoryBytesEach)} each${g.registryName ? ` · ${esc(g.registryName)}` : ''})`).join('<br>') || '<span class="muted">none detected</span>';
  $('stats').innerHTML = kv([
    ['CPU', `${esc(stats.cpuModel.split('@')[0].trim())} ×${stats.cpus}`],
    ['Memory', `${gi(stats.totalMemBytes - stats.freeMemBytes)} used / ${gi(stats.totalMemBytes)}`],
    ['Disk free', gb(stats.diskFreeBytes)],
    ['Accelerators', gpu],
    ['Docker', stats.dockerReady ? '<span class="tag ok">available</span>' : '<span class="tag bad">not running</span>'],
  ]);
  const active = snapshotCache?.active;
  $('running').innerHTML = active
    ? kv([
        ['Model', esc(active.recipe?.model?.name ?? active.recipeId)],
        ['Engine', esc(active.recipe?.engine?.name ?? '')],
        ['Endpoint', `<code>http://127.0.0.1:${active.port}/v1</code>`],
        ['State', stateTag(stats)],
      ])
    : '<span class="muted">No model loaded.</span>';
  $('reginfo').innerHTML = kv([
    ['Source', '<code>0xSero/local-ai-registry</code>'],
    ['Commit', esc(snapshotCache?.registry?.commit ?? '—')],
    ['Recipes', `${snapshotCache?.models?.length ?? 0} compatible / ${snapshotCache?.registry?.recipes ?? snapshotCache?.registry?.totalRecipeCount ?? 0} total`],
    ['Synced', snapshotCache?.registry?.synced ? '<span class="tag ok">yes</span>' : '<span class="tag warn">not yet — press Sync</span>'],
  ]);
};

const renderModels = (models, stats) => {
  if (!models.length) {
    $('models').innerHTML = '<div style="padding:12px 16px" class="muted">No registry recipes run on this machine\'s accelerators. Sync the registry, or use it on a host with a registry-matched GPU.</div>';
    return;
  }
  $('models').innerHTML = models.map((m) => {
    const dl = m.downloaded ? '<span class="tag ok">downloaded</span>' : '<span class="tag">not downloaded</span>';
    const buttons = m.active
      ? `<button data-act="unload">Unload</button><button data-act="dsh" data-id="${esc(m.id)}">Harness</button>`
      : [
          m.downloaded
            ? `<button data-act="load" data-id="${esc(m.id)}" ${m.ready && stats.dockerReady ? '' : 'disabled'}>Load</button>`
            : `<button data-act="download" data-id="${esc(m.id)}" ${stats.dockerReady ? '' : 'disabled'}>Download (${gb(m.model.downloadBytes)})</button>`,
        ].join('');
    const busyTag = m.compatible && !m.ready ? '<span class="tag warn">GPUs busy</span>' : '';
    return `<div class="model ${m.active ? 'active' : ''}">
      <div class="row1"><span class="name">${esc(m.model.name)}</span>
        <span class="tag">${esc(m.model.weightPrecision ?? m.model.weightFormat ?? '')}</span>
        <span class="tag">${esc(m.engine.name)}</span>
        <span class="tag">×${m.compatibility.acceleratorCount}</span>
        ${m.active ? '<span class="tag ok">running</span>' : ''} ${dl} ${busyTag}</div>
      <div class="meta">${esc(m.compatibility.hardwareName)} · ${esc(m.model.repository)} · ${gi(m.model.downloadBytes)} · ctx ${m.serving.configuredMaxContextTokens.toLocaleString()}</div>
      <div class="actions">${buttons}</div>
    </div>`;
  }).join('');
};

let snapshotCache = null;
let busy = false;

const unwrap = (res) => {
  if (res?.ok) return res.data;
  throw new Error(res?.error ?? 'action failed');
};

const refresh = async () => {
  const snap = unwrap(await hub.snapshot());
  snapshotCache = snap;
  renderStats(snap.stats);
  renderModels(snap.models, snap.stats);
  $('dsh-state').textContent = snap.dsh.running ? `harness on :${snap.dsh.port}` : '';
  return snap;
};

const doAction = async (label, fn) => {
  if (busy) return;
  busy = true;
  setStatus(`${label}…`);
  try {
    const data = unwrap(await fn());
    setStatus(data?.detail || `${label} done`);
    return data;
  } catch (e) {
    setStatus(e.message ?? String(e), true);
  } finally {
    busy = false;
    await refresh();
  }
};

const startHarness = async () => {
  const cwd = $('dsh-cwd').value.trim();
  const data = await doAction('Opening harness', () => hub.openDsh(cwd || undefined));
  if (data?.url) mountHarness(data.url);
  else if (typeof data === 'object' && data?.ok && data.url) mountHarness(data.url);
};

let harnessUrl = null;
const mountHarness = (url) => {
  harnessUrl = url;
  const isElectron = navigator.userAgent.includes('Electron');
  $('harness').innerHTML = isElectron
    ? `<webview src="${esc(url)}" allowpopups></webview>`
    : `<iframe src="${esc(url)}" style="width:100%;height:70vh;border:0"></iframe>`;
  const empty = $('harness-empty');
  if (empty) empty.remove();
};
const unmountHarness = () => {
  harnessUrl = null;
  $('harness').innerHTML = '<div id="harness-empty">Load a model, then open the harness here.</div>';
};

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const { act, id } = btn.dataset;
  if (act === 'load') await doAction('Loading model', () => hub.load(id));
  if (act === 'download') await doAction('Downloading', () => hub.download(id));
  if (act === 'unload') { await doAction('Unloading', () => hub.unload()); unmountHarness(); }
  if (act === 'dsh') await startHarness();
});

$('btn-sync').onclick = () => doAction('Syncing registry', () => hub.syncRegistry());
$('btn-dsh').onclick = startHarness;
$('btn-stop-dsh').onclick = async () => { await hub.stopDsh(); unmountHarness(); $('dsh-state').textContent = ''; setStatus('harness stopped'); };

// Poll while a model is loading: the Load action blocks until acceptance, and
// the snapshot picks up the transition afterwards.
setInterval(() => { if (!busy) refresh().catch(() => {}); }, 5000);

refresh().catch((e) => setStatus(e.message, true));
