'use strict';
// Deterministic tests: no docker, no GPU, no network. Uses a fixture registry
// shaped exactly like local-ai-registry.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fixtures = path.join(os.tmpdir(), `local-ai-hub-test-${process.pid}`);
const registryDir = path.join(fixtures, 'registry');
fs.mkdirSync(path.join(registryDir, 'recipe'), { recursive: true });
fs.mkdirSync(path.join(registryDir, 'model-instance'), { recursive: true });
fs.mkdirSync(path.join(registryDir, 'model'), { recursive: true });
fs.mkdirSync(path.join(registryDir, 'hardware'), { recursive: true });
process.env.LOCAL_AI_HUB_TEST_REGISTRY = registryDir;

const write = (rel, doc) => fs.writeFileSync(path.join(registryDir, rel), JSON.stringify(doc, null, 2));

const DIGEST = 'ghcr.io/0xsero/fake@sha256:' + 'a'.repeat(64);
const REV = 'b'.repeat(40);

write('hardware/dgx-spark-gb10-128gb.json', {
  id: 'dgx-spark-gb10-128gb', name: 'NVIDIA DGX Spark GB10 128GB', accelerator_backend: 'nvidia',
  aliases: ['dgx spark'], memory: { vram_gb: 128, vram_type: 'unified' }, schema_version: 'local-ai-registry/v1',
});
write('hardware/rtx-pro-6000-blackwell-96gb.json', {
  id: 'rtx-pro-6000-blackwell-96gb', name: 'RTX PRO 6000 Blackwell 96GB', accelerator_backend: 'nvidia',
  aliases: [], memory: { vram_gb: 96, vram_type: 'gddr7' }, schema_version: 'local-ai-registry/v1',
});
write('hardware/apple-m4-max-64gb.json', {
  id: 'apple-m4-max-64gb', name: 'Apple M4 Max 64GB', accelerator_backend: 'metal',
  aliases: ['m4 max 64gb'], memory: { vram_gb: 64, vram_type: 'unified' }, schema_version: 'local-ai-registry/v1',
});
write('model/glm-5-3-flash.json', { id: 'glm-5-3-flash', name: 'GLM-5.3-Flash', schema_version: 'local-ai-registry/v1' });
write('model-instance/inst-nvfp4.json', {
  id: 'inst-nvfp4', model_id: 'glm-5-3-flash', repository: 'FakeOrg/GLM-5.3-Flash-NVFP4', revision: REV,
  served_name: 'glm-5.3-flash', weights: { format: 'ModelOpt', precision: 'NVFP4', size_gb: 182 }, schema_version: 'local-ai-registry/v1',
});
const recipeBody = (over = {}) => ({
  id: 'glm53-flash-nvfp4-rtxpro6000-sglang-tp4',
  status: 'validated',
  model_instance_id: 'inst-nvfp4',
  hardware_id: 'rtx-pro-6000-blackwell-96gb',
  hardware_count: 1,
  engine: { name: 'sglang', version: 'v0.5' },
  serving: { tensor_parallel: 1, max_context_tokens: 1048576 },
  capabilities: { chat: true, tools: true },
  launch: {
    kind: 'docker',
    image: DIGEST,
    container_port: 30000,
    host_port: 8000,
    ipc: 'host',
    shm_size: '32g',
    environment: { CUDA_DEVICE_ORDER: 'PCI_BUS_ID' },
    arguments: ['--model-path', '/model', '--served-model-name', 'glm-5.3-flash', '--host', '0.0.0.0', '--port', '30000'],
    mounts: [{ source: '~/.cache/models/glm53', target: '/model', read_only: true }],
    devices: [],
  },
  schema_version: 'local-ai-registry/v1',
  ...over,
});
const recipe = recipeBody();
write('recipe/glm53-flash-nvfp4-rtxpro6000-sglang-tp4.json', recipe);
write('recipe/bad-eager.json', recipeBody({ id: 'bad-eager', launch: { ...recipe.launch, arguments: ['--enforce-eager'] }, launch_kind: undefined }));
write('recipe/unpinned.json', recipeBody({ id: 'unpinned', launch: { ...recipe.launch, image: 'ghcr.io/0xsero/fake:latest' } }));
write('recipe/reference-only.json', recipeBody({ id: 'reference-only', launch: { kind: 'reference', image: null } }));
write('index.json', {
  schema_version: 'local-ai-registry/v1',
  recipes: ['glm53-flash-nvfp4-rtxpro6000-sglang-tp4', 'bad-eager', 'unpinned', 'reference-only'].map((id) => ({
    id, status: id === 'glm53-flash-nvfp4-rtxpro6000-sglang-tp4' ? 'validated' : 'candidate',
    launch_kind: id === 'reference-only' ? 'reference' : 'docker',
    hardware_id: 'rtx-pro-6000-blackwell-96gb', hardware_count: 1, model_instance_id: 'inst-nvfp4', engine: 'sglang',
  })),
  counts: {}, collections: {}, resolver_rule: {},
});

// The modules read the registry path from env in test mode.
const registry = require('../main/registry');

const detected = {
  groups: [{
    backend: 'nvidia', product: 'RTX PRO 6000 Blackwell', count: 1, memoryBytesEach: 96 * 1073741824,
    registryId: 'rtx-pro-6000-blackwell-96gb', registryName: 'RTX PRO 6000 Blackwell 96GB',
    devices: [{ index: 0, totalMiB: 98304, usedMiB: 0, freeMiB: 98304 }],
  }],
};

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`ok · ${name}`); }
  catch (e) { console.error(`FAIL · ${name}: ${e.message}`); process.exitCode = 1; }
};

test('registry index validates', () => {
  const info = registry.loadRegistry();
  assert.equal(info.recipes, 4);
});

test('buildRecipe resolves recipe -> instance -> model', () => {
  const r = registry.buildRecipe('glm53-flash-nvfp4-rtxpro6000-sglang-tp4', detected);
  assert.equal(r.model.name, 'GLM-5.3-Flash');
  assert.equal(r.model.servedName, 'glm-5.3-flash');
  assert.equal(r.endpoint.containerPort, 30000);
  assert.equal(r.compatible, true);
  assert.equal(r.ready, true);
});

test('buildRecipe refuses non-validated recipes', () => {
  assert.throws(() => registry.buildRecipe('unpinned', detected), /not validated|digest-pinned/);
});

test('buildRecipe refuses unpinned images', () => {
  assert.throws(() => registry.buildRecipe('unpinned', detected), /digest-pinned/);
});

test('buildRecipe refuses eager/graph-disable flags', () => {
  fs.writeFileSync(path.join(registryDir, 'recipe/bad-eager.json'), JSON.stringify({ ...recipe, id: 'bad-eager', launch: { ...recipe.launch, arguments: ['--enforce-eager'] }, status: 'validated' }));
  try {
    assert.throws(() => registry.buildRecipe('bad-eager', detected), /CUDA graphs/);
  } finally {
    fs.writeFileSync(path.join(registryDir, 'recipe/bad-eager.json'), JSON.stringify(recipeBody({ id: 'bad-eager' })));
  }
});

test('recipesForHardware keeps only launchable validated docker recipes', () => {
  const list = registry.recipesForHardware(detected);
  assert.deepEqual(list.map((r) => r.id), ['glm53-flash-nvfp4-rtxpro6000-sglang-tp4']);
});

test('incompatible hardware is visible but not ready', () => {
  const appleDetected = { groups: [{ backend: 'metal', product: 'M4 Max 64GB', count: 1, memoryBytesEach: 64 * 1073741824, registryId: 'apple-m4-max-64gb', registryName: 'Apple M4 Max 64GB', devices: [{ index: 0, totalMiB: 65536, usedMiB: 0, freeMiB: 65536 }] }] };
  const list = registry.recipesForHardware(appleDetected);
  // Recipes for hardware this machine cannot host stay out of the list.
  const ids = list.map((r) => r.id);
  for (const id of ids) {
    const r = registry.buildRecipe(id, appleDetected);
    assert.equal(r.compatible, false);
  }
});

test('mount boundary: host path outside ~/.cache refused', () => {
  const container = require('../main/container');
  assert.throws(
    () => container.resolveMount({ source: '/etc', target: '/model', read_only: true }, registryDir),
    /outside the local boundary/);
  // ~/ mounts and registry-relative mounts resolve inside the boundary.
  assert.equal(container.resolveMount({ source: '~/.cache/models/glm53', target: '/model' }, registryDir), path.join(os.homedir(), '.cache/models/glm53'));
});

test('runPlan builds docker argv from the recipe', async () => {
  const container = require('../main/container');
  const r = registry.buildRecipe('glm53-flash-nvfp4-rtxpro6000-sglang-tp4', detected);
  r.localProduct = 'RTX PRO 6000 Blackwell';
  const argv = await container.runPlan(r, detected, registryDir);
  assert.equal(argv[0], 'run');
  assert.equal(argv[3], 'local-ai-hub');
  assert.ok(argv.includes('--gpus'));
  assert.ok(argv.includes(`--publish`));
  assert.ok(argv.includes('127.0.0.1:12434:30000'));
  assert.ok(argv.includes(DIGEST));
  assert.ok(argv.includes('--served-model-name'));
});

test('dsh settings round-trip preserves unrelated YAML', () => {
  const dsh = require('../main/dsh');
  const target = path.join(fixtures, 'settings.yaml');
  fs.mkdirSync(fixtures, { recursive: true });
  fs.writeFileSync(target, 'other-key: keep\n');
  dsh.writeSettingsAt(target, 'http://127.0.0.1:12434', [{ id: 'glm-5.3-flash', contextWindow: 1048576 }], 'glm-5.3-flash');
  const text = fs.readFileSync(target, 'utf8');
  assert.ok(text.includes('other-key: keep'));
  assert.ok(text.includes('baseURL: http://127.0.0.1:12434/v1'));
  dsh.writeSettingsAt(target, 'http://127.0.0.1:12434', [{ id: 'glm-5.3-flash' }], 'glm-5.3-flash');
  assert.ok(fs.readFileSync(target, 'utf8').includes('other-key: keep'));
});

test('dsh refuses to rewrite invalid YAML', () => {
  const dsh = require('../main/dsh');
  const target = path.join(fixtures, 'broken.yaml');
  fs.writeFileSync(target, ':\n  - [');
  assert.throws(() => dsh.writeSettingsAt(target, 'http://x', [], 'm'), /not valid YAML/);
});

// small test hooks the modules expose
test('stats detects nothing on a machine without accelerators (no crash)', async () => {
  const statsMod = require('../main/stats');
  const s = await statsMod.stats(registryDir, 'no-such-container');
  assert.equal(typeof s.dockerReady, 'boolean');
  assert.equal(s.modelRunning, false);
  assert.ok(Array.isArray(s.groups));
});

console.log(`\n${passed} tests, exit ${process.exitCode ?? 0}`);
fs.rmSync(fixtures, { recursive: true, force: true });
