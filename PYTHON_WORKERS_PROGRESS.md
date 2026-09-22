# Python Workers progress

## Mandate

Autonomous local implementation and validation through 2026-10-05 19:22 America/Los_Angeles. Worktree: `/Users/kylekelley/.codex/worktrees/celld-python-workers/celld`; branch `quod/python-workers`; base v0.5.1 `42269c1`. The detailed scope and gates are in `docs/python-workers-plan.md`. Monty is a separate project and out of scope.

Recurring continuation: `build-python-workers-for-celld`, every four hours until 2026-10-06 02:22 UTC. Only meaningful milestone/blocker notifications. Work locally, retain evidence, commit coherent verified increments. No live fleet deployment, release/merge, or upstream outreach.

## Current slice — first HTTP/binding milestone passed

Bootstrap a pinned upstream Pyodide 0.28.3 inside the real celld 0.5.1 HTTP path. Test a stdlib import, async request, and one binding before adding native Python deployment metadata. Assets are local and pinned; fixture-only packaging is allowed for this spike.

## Environment

- System celld is 0.4.1; do not use it for this work.
- Downloaded v0.5.1 binary is `.celld/tools/celld` (task-local).
- Initial experiment lives in `experiments/python-workers`.

## Evidence (2026-09-21 evening)

- An unmodified celld 0.5.1 binary executes pinned Pyodide 0.28.3 / CPython 3.13.2 inside its V8 isolates. No celld Rust changes yet.
- `cd experiments/python-workers && npm ci --ignore-scripts --no-audit --no-fund && npm run build && npm test` reproduces the milestone. The default binary is task-local `.celld/tools/celld`; override `CELLD_BIN` if needed.
- Five HTTP integration scenarios pass (six Node test records including the parent): four concurrent initial requests; actual awaited KV write/read; actual outbound fetch to a local HTTP server; Python traceback and subsequent successful request; twenty warm requests with independent inputs.
- Latest captured run: `experiments/python-workers/evidence/2026-09-21-smoke.json`. Four initial requests complete in 878.5 ms, spanning two observed interpreter IDs. Each reports one initialization. Warm requests are around 2 ms.
- Node RSS before Python: 102368 KiB; after all requests: 419424 KiB. This is a whole-node sample, includes pooling/KV, and is NOT evidence of a leak or a per-interpreter allocation figure. Memory pressure and lifecycle work are important next gates.
- Runtime artifact SHA-256/size/ABI information is retained in `experiments/python-workers/evidence/runtime-manifest.json`; npm dependencies have a committed lockfile. Combined deploy upload is about 13 MiB / 5.3 MiB gzip, using fixture-only stdlib embedding.
- Task-created manual dev server on port 18976 was stopped. Automated tests clean up their process groups and local storage. No persistent test server is required between runs.

## Diagnosed issues and limitations

- Pyodide initially failed environment detection. Bundle-local worker-environment shims now select its browser-worker path without replacing host globals.
- The first native asynchronous Wasm path stalled. A fixture-local WebAssembly facade uses synchronous constructors plus promises and celld's compiled-module import. Still needs a minimized native-async repro and host task-pumping investigation; do not report the host behavior as fully diagnosed.
- A subsequent Wasm memory error reproduced with the same generated bundle under Node. The real cause was Emscripten's shell entropy path attempting `os.system`, leaving Python incompletely initialized. Selecting the worker environment uses `crypto.getRandomValues` and fixes the original HTTP repro.
- `worker.py` currently uses `from js import Response, fetch` and a custom `handle(request, env)` function. This is NOT yet the Cloudflare `workers` SDK, native `.py` deploy support, workerd parity, Python Durable Objects, execution-limit qualification, or leak resistance.
- `docs/python-workers-plan.md` remains the original pre-implementation research snapshot; this file records newer execution evidence.

## Next action

1. Add a pinned workerd reference fixture using the same Python source and equivalent bindings, record the Python/Pyodide version difference explicitly, and compare normalized outputs.
2. Minimize the async-Wasm stall into a tiny independent fixture before considering Rust changes. Inspect existing event pumping and V8 foreground tasks; avoid masking errors with a global override.
3. Instrument interpreter count across the entire worker pool, linear-memory sizes, and repeated request/eviction RSS. Establish resource-limit termination behavior (including state after a killed Python loop) using an isolated worker and bounded external watchdog.
4. Audit/reuse the real Workers SDK entrypoint bridge, then progress through packaging and Python Durable Object gates in the plan. Do not expand features around an unqualified resource lifecycle.

Keep tests meaningful and local. Retain exact failing evidence and next actions if a slice cannot finish in one run. Make coherent local commits. Public outreach and PR publication remain outside this recurring prompt.
