'use strict';
// Registry sync: clone or fast-forward the local-ai-registry repo, validate it,
// and resolve launchable recipes for the detected hardware.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const REGISTRY_REMOTE = 'https://github.com/0xSero/local-ai-registry.git';
const REGISTRY_DIR = process.env.LOCAL_AI_HUB_TEST_REGISTRY || path.join(os.homedir(), 'local-ai-hub', 'registry');
const MAX_BYTES = 1024 * 1024 * 8; // refuse records that are absurdly large

const sh = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout: opts.timeout ?? 60_000, maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || ''); reject(err); return; }
      resolve(String(stdout));
    });
    child.stdin?.end(opts.stdin ?? null);
  });

const readJson = (file) => {
  const st = fs.statSync(file);
  if (st.size > MAX_BYTES) throw new Error(`record too large: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
};

const validateRegistry = (dir) => {
  const index = readJson(path.join(dir, 'index.json'));
  if (index.schema_version !== 'local-ai-registry/v1') throw new Error('unknown registry schema');
  if (!Array.isArray(index.recipes) || index.recipes.length === 0) throw new Error('registry has no recipes');
  return index;
};

// Clone on first run, then fast-forward only. Local edits are refused, not overwritten.
const syncRegistry = async () => {
  fs.mkdirSync(path.dirname(REGISTRY_DIR), { recursive: true });
  if (!fs.existsSync(path.join(REGISTRY_DIR, '.git'))) {
    await sh('git', ['clone', '--filter=blob:none', '--branch', 'main', REGISTRY_REMOTE, REGISTRY_DIR], { timeout: 300_000 });
  } else {
    const dirty = await sh('git', ['-C', REGISTRY_DIR, 'status', '--porcelain']);
    if (dirty.trim()) throw new Error('registry checkout has local changes; refusing to overwrite them');
    const branch = (await sh('git', ['-C', REGISTRY_DIR, 'branch', '--show-current'])).trim();
    if (branch !== 'main') throw new Error('registry checkout must be on main');
    await sh('git', ['-C', REGISTRY_DIR, 'fetch', 'origin', 'main'], { timeout: 300_000 });
    await sh('git', ['-C', REGISTRY_DIR, 'merge', '--ff-only', 'origin/main'], { timeout: 300_000 });
  }
  const index = validateRegistry(REGISTRY_DIR);
  const commit = (await sh('git', ['-C', REGISTRY_DIR, 'rev-parse', '--short', 'HEAD'])).trim();
  return { recipes: index.recipes.length, commit, path: REGISTRY_DIR };
};

const loadRegistry = () => {
  const index = validateRegistry(REGISTRY_DIR);
  const commit = fs.existsSync(path.join(REGISTRY_DIR, '.git'))
    ? require('node:child_process').execSync('git rev-parse --short HEAD', { cwd: REGISTRY_DIR }).toString().trim()
    : '';
  return { recipes: index.recipes.length, commit, path: REGISTRY_DIR };
};

// Build the launch model for one recipe, mirroring omarchy-local-ai/lib/core.sh
// resolved_recipe: recipe -> model-instance -> model + hardware, with the
// same safety gates (pinned digest, pinned revision, no eager/graph-disable flags).
const arg = (recipe, name) => {
  const a = recipe.launch?.arguments ?? [];
  const i = a.indexOf(name);
  return i >= 0 ? a[i + 1] : null;
};

const buildRecipe = (recipeId, detected) => {
  const recipe = readJson(path.join(REGISTRY_DIR, 'recipe', `${recipeId}.json`));
  if (recipe.status !== 'validated') throw new Error(`${recipeId} is not validated`);
  const launch = recipe.launch;
  if (launch?.kind !== 'docker') throw new Error(`${recipeId} is not a docker recipe`);
  const image = launch.image ?? launch.container?.image ?? null;
  if (!image || !/^[^@]+@sha256:[0-9a-f]{64}$/.test(image)) throw new Error(`${recipeId} has no digest-pinned image`);
  const instance = readJson(path.join(REGISTRY_DIR, 'model-instance', `${recipe.model_instance_id}.json`));
  if (!/^[0-9a-f]{40,64}$/.test(instance.revision)) throw new Error(`${recipeId} has no pinned model revision`);
  const model = readJson(path.join(REGISTRY_DIR, 'model', `${instance.model_id}.json`));
  const hardware = readJson(path.join(REGISTRY_DIR, 'hardware', `${recipe.hardware_id}.json`));
  const args = launch.arguments ?? [];
  const badArgs = args.filter((a) => /disable.*cuda.*graph|enforce.eager/i.test(a));
  if (badArgs.length) throw new Error(`${recipeId} disables CUDA graphs; refused`);

  const group = detected.groups.find((g) => g.registryId === recipe.hardware_id);
  const count = recipe.hardware_count ?? 1;
  const compatible = group ? group.count >= count : false;
  const ready = group
    ? compatible && (hardware.accelerator_backend === 'metal' || group.devices.filter((d) => d.freeMiB >= hardware.memory.vram_gb * 1024 * 0.88).length >= count)
    : false;

  return {
    id: recipe.id,
    status: recipe.status,
    model: {
      id: model.id,
      name: model.name,
      repository: instance.repository,
      revision: instance.revision,
      servedName: arg(recipe, '--served-model-name') ?? instance.served_name ?? instance.repository,
      weightFormat: instance.weights?.format,
      weightPrecision: instance.weights?.precision,
      downloadBytes: Math.floor((instance.weights?.size_gb ?? 0) * 1073741824),
    },
    compatibility: {
      acceleratorBackend: hardware.accelerator_backend,
      acceleratorCount: count,
      hardwareId: hardware.id,
      hardwareName: hardware.name,
    },
    endpoint: { protocol: 'openai/v1', containerPort: launch.container_port },
    engine: { name: recipe.engine?.name, version: recipe.engine?.version, graphMode: recipe.engine?.graph_mode },
    launch: {
      image,
      entrypoint: launch.entrypoint ?? null,
      ipc: launch.ipc ?? null,
      shmSize: launch.shm_size ?? null,
      environment: launch.environment ?? {},
      arguments: args,
      mounts: launch.mounts ?? [],
      devices: launch.devices ?? [],
    },
    serving: {
      configuredMaxContextTokens: recipe.serving?.max_context_tokens ?? arg(recipe, '--context-length') ?? arg(recipe, '--max-model-len') ?? 32768,
      tensorParallel: recipe.serving?.tensor_parallel ?? 1,
    },
    capabilities: recipe.capabilities ?? {},
    localProduct: group?.product ?? null,
    localCount: group?.count ?? 0,
    compatible,
    ready,
    description: recipe.description ?? null,
  };
};

// Only recipes this machine can actually host: the detected accelerators must
// match the recipe's registry hardware record and provide enough devices.
const recipesForHardware = (detected) => {
  const index = validateRegistry(REGISTRY_DIR);
  const out = [];
  for (const entry of index.recipes) {
    if (entry.status !== 'validated' || entry.launch_kind !== 'docker') continue;
    try {
      const built = buildRecipe(entry.id, detected);
      if (!built.compatible) continue; // other machines' recipes stay out of the list
      out.push(built);
    } catch {
      // unpinned or unsafe recipes stay out of the list
    }
  }
  const activeId = detected.activeRecipeId ?? '';
  return out.sort((a, b) =>
    Number(a.id !== activeId) - Number(b.id !== activeId) ||
    a.compatibility.acceleratorCount - b.compatibility.acceleratorCount ||
    Number(!a.ready) - Number(!b.ready) ||
    a.model.name.localeCompare(b.model.name));
};

module.exports = { get REGISTRY_DIR() { return REGISTRY_DIR; }, REGISTRY_REMOTE, syncRegistry, loadRegistry, buildRecipe, recipesForHardware, sh };
