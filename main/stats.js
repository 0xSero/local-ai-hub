'use strict';
// Machine stats: accelerators (nvidia / intel XPU / apple unified memory),
// RAM, disk, docker availability. Detection matches omarchy-local-ai hardware
// matching so registry recipes resolve against the same registry hardware ids.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const run = (cmd, args, timeout = 10_000) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout) => resolve(err ? null : String(stdout)));
  });

const norm = (s) => s.toLowerCase().replace(/nvidia|geforce|intel|generation|workstation|edition|[0-9]+gb|[^a-z0-9]/g, '');

const nvidiaGroups = async () => {
  const out = await run('nvidia-smi', [
    '--query-gpu=index,name,memory.total,memory.used,memory.free',
    '--format=csv,noheader,nounits']);
  if (!out) return [];
  const rows = out.trim().split('\n').map((l) => l.split(',').map((c) => c.trim()));
  const gpus = rows.map((r) => ({ index: Number(r[0]), product: r[1], totalMiB: Number(r[2]), usedMiB: Number(r[3]), freeMiB: Number(r[4]) }));
  const groups = new Map();
  for (const g of gpus) {
    const key = `${g.product}|${g.totalMiB}`;
    if (!groups.has(key)) groups.set(key, { backend: 'nvidia', product: g.product, count: 0, memoryBytesEach: g.totalMiB * 1048576, devices: [] });
    const grp = groups.get(key);
    grp.count += 1;
    grp.devices.push({ index: g.index, totalMiB: g.totalMiB, usedMiB: g.usedMiB, freeMiB: g.freeMiB });
  }
  return [...groups.values()];
};

const intelGroups = async () => {
  // Arc / XPU on Linux: count render nodes via lspci; on macOS there is none.
  if (process.platform === 'darwin') return [];
  const out = await run('sh', ['-c', "lspci -Dnn 2>/dev/null | grep -ci 'Arc Pro B70' || true"]);
  const count = Number((out ?? '0').trim());
  if (!count) return [];
  return [{ backend: 'intel-xpu', product: 'Intel Arc Pro B70', count, memoryBytesEach: 34359738368, devices: Array.from({ length: count }, (_, i) => ({ index: i, totalMiB: 32768, freeMiB: 32768 })) }];
};

const appleGroup = async () => {
  if (process.platform !== 'darwin') return [];
  const out = await run('system_profiler', ['SPHardwareDataType', '-json'], 15_000);
  if (!out) return [];
  let hw;
  try { hw = JSON.parse(out).SPHardwareDataType[0]; } catch { return []; }
  const chip = hw.chip_type || (hw.name ?? '').split(' ')[0];
  const ram = Number((hw.physical_memory ?? '').replace(/[^0-9]/g, '')) || Math.round(os.totalmem() / 1073741824);
  const used = Math.round((os.totalmem() - os.freemem()) / 1048576);
  return [{
    backend: 'metal',
    product: `${chip} ${ram}GB`,
    count: 1,
    memoryBytesEach: ram * 1073741824,
    devices: [{ index: 0, totalMiB: ram * 1024, usedMiB: used, freeMiB: ram * 1024 - used }],
  }];
};

// Match detected groups against registry hardware ids so recipes resolve.
// Works for both upstream layouts (records at <dir> or <dir>/data/registry).
const annotate = async (groups, registryDir) => {
  let known = [];
  try {
    const candidates = [path.join(registryDir, 'hardware'), path.join(registryDir, 'data', 'registry', 'hardware')];
    const dir = candidates.find((c) => { try { return fs.statSync(c).isDirectory(); } catch { return false; } });
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    known = files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  } catch { /* registry missing; ids stay empty */ }
  return groups.map((g) => {
    const match = known.find((h) =>
      h.accelerator_backend === g.backend &&
      (norm(h.name) === norm(g.product) || (h.aliases ?? []).some((a) => norm(a) === norm(g.product))) &&
      Math.abs((h.memory?.vram_gb ?? 0) * 1024 - g.memoryBytesEach / 1048576) <= 1024);
    return { ...g, registryId: match?.id ?? '', registryName: match?.name ?? '' };
  });
};

const dockerAvailable = async () => {
  const out = await run('docker', ['info', '--format', '{{.ServerVersion}}'], 5_000);
  return Boolean(out && out.trim());
};

const containerRunning = async (name) => {
  const out = await run('docker', ['inspect', '-f', '{{.State.Running}}', name], 5_000);
  return (out ?? '').trim() === 'true';
};

const diskFreeBytes = () => {
  const home = os.homedir();
  const out = require('node:child_process').execSync(`df -Pk ${JSON.stringify(home)} 2>/dev/null`).toString();
  const line = out.split('\n')[1] ?? '';
  const cols = line.trim().split(/\s+/);
  return (Number.parseInt(cols[3], 10) || 0) * 1024;
};

const stats = async (registryDir, containerName) => {
  const [nv, ix, ap] = await Promise.all([nvidiaGroups(), intelGroups(), appleGroup()]);
  const groups = await annotate([...nv, ...ix, ...ap], registryDir);
  return {
    platform: process.platform,
    host: os.hostname(),
    arch: os.arch(),
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model ?? '',
    totalMemBytes: os.totalmem(),
    freeMemBytes: os.freemem(),
    diskFreeBytes: diskFreeBytes(),
    dockerReady: await dockerAvailable(),
    modelRunning: await containerRunning(containerName),
    groups,
    uptimeS: Math.round(os.uptime()),
    collectedAt: new Date().toISOString(),
  };
};

module.exports = { stats, dockerAvailable, containerRunning, nvidiaGroups, appleGroup, diskFreeBytes };
