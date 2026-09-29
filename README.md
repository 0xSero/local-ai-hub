# Local AI Hub

A simple cross-platform desktop app (Electron) that shows machine stats, lists the
models the [local-ai-registry](https://github.com/0xSero/local-ai-registry) says can
run on this machine, and runs one with one click in a single managed docker
container — then embeds the DeepSeek harness (`dsh web`) pointed at that model.

Simpler sibling of the [omarchy-local-ai](https://github.com/0xSero/omarchy-local-ai)
Omarchy plugin: same registry, same one-container contract, same acceptance gate,
no Omarchy required.

## Run

    npm install
    npm start

First launch: press **Sync registry** to clone
`0xSero/local-ai-registry` into `~/local-ai-hub/registry` (fast-forward only on
later syncs; local edits are refused, never overwritten).

## What it does

1. **This machine** — CPU, RAM, disk, accelerators (NVIDIA / Intel Arc / Apple
   unified memory) matched against registry hardware ids, docker availability.
2. **Models** — every *validated* registry docker recipe whose hardware this
   machine can host. Recipes with unpinned images, unpinned revisions or
   eager/CUDA-graph-disabling flags are refused outright.
3. **Download** — pulls the digest-pinned image, then fetches the exact model
   revision with the image's own `hf` CLI into `~/.cache/huggingface`.
4. **Load** — `docker run` straight from the recipe, then acceptance: the
   endpoint must answer `/v1/models` and return a real completion containing
   `LOCAL_AI_READY`. On failure the previous container is restored.
5. **Harness** — starts `dsh web` on :3090 against the loaded endpoint
   (`~/.local/state/local-ai-hub/dsh`, user dsh state untouched) and embeds it
   in the window. Requires `dsh` on PATH (`npx @deepseek-ai/dsh web` upstream).

## Endpoint

`http://127.0.0.1:12434/v1` (OpenAI-compatible), loopback only.

## Tests

    npm test

12 deterministic tests, no docker, no GPU, no network.
