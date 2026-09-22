# Python Workers progress

## Mandate

Autonomous local implementation and validation through 2026-10-05 19:22 America/Los_Angeles. Worktree: `/Users/kylekelley/.codex/worktrees/celld-python-workers/celld`; branch `quod/python-workers`; base v0.5.1 `42269c1`. The detailed scope and gates are in `docs/python-workers-plan.md`. Monty is a separate project and out of scope.

Recurring continuation: `build-python-workers-for-celld`, every four hours until 2026-10-06 02:22 UTC. Only meaningful milestone/blocker notifications. Work locally, retain evidence, commit coherent verified increments. No live fleet deployment, release/merge, or upstream outreach.

Kyle explicitly requested `/goal`; the durable goal is ACTIVE with no token
budget. See `GOAL.md` and the goal tool. Continue immediately while there is
authorized work; do not wait for the heartbeat to make progress.

## Current slice — first HTTP/binding milestone passed

Bootstrap a pinned upstream Pyodide 0.28.3 inside the real celld 0.5.1 HTTP path. Test a stdlib import, async request, and one binding before adding native Python deployment metadata. Assets are local and pinned; fixture-only packaging is allowed for this spike.

## Environment

- System celld is 0.4.1; do not use it for this work.
- Downloaded v0.5.1 binary is `.celld/tools/celld` (task-local).
- Initial experiment lives in `experiments/python-workers`.

## Evidence (2026-09-21 evening)

- An unmodified celld 0.5.1 binary executes pinned Pyodide 0.28.3 / CPython 3.13.2 inside its V8 isolates. No celld Rust changes yet.
- `cd experiments/python-workers && npm ci --ignore-scripts --no-audit --no-fund && npm run build && npm run test:smoke` reproduces the passing milestone. `npm test` additionally includes the known red resource lifecycle gate. The default binary is task-local `.celld/tools/celld`; override `CELLD_BIN` if needed.
- Five HTTP integration scenarios pass (six Node test records including the parent): four concurrent initial requests; actual awaited KV write/read; actual outbound fetch to a local HTTP server; Python traceback and subsequent successful request; twenty warm requests with independent inputs.
- Latest captured run: `experiments/python-workers/evidence/2026-09-21-smoke.json`. Four initial requests complete in 878.5 ms, spanning two observed interpreter IDs. Each reports one initialization. Warm requests are around 2 ms.
- Node RSS before Python: 102368 KiB; after all requests: 419424 KiB. This is a whole-node sample, includes pooling/KV, and is NOT evidence of a leak or a per-interpreter allocation figure. Memory pressure and lifecycle work are important next gates.
- Runtime artifact SHA-256/size/ABI information is retained in `experiments/python-workers/evidence/runtime-manifest.json`; npm dependencies have a committed lockfile. Combined deploy upload is about 13 MiB / 5.3 MiB gzip, using fixture-only stdlib embedding.
- Task-created manual dev server on port 18976 was stopped. Automated tests clean up their process groups and local storage. No persistent test server is required between runs.

## Diagnosed issues and limitations

- Pyodide initially failed environment detection. Bundle-local worker-environment shims now select its browser-worker path without replacing host globals.
- The first native asynchronous Wasm path stalled. A minimized probe now distinguishes raw-byte compilation (stalls) from native async instantiation of a compiled module (passes). The fixture uses compiled interpreter and sentinel imports, eliminating its former synchronous-constructor fallback. Host task pumping remains an unproven explanation for the separate raw-byte stall.
- A subsequent Wasm memory error reproduced with the same generated bundle under Node. The real cause was Emscripten's shell entropy path attempting `os.system`, leaving Python incompletely initialized. Selecting the worker environment uses `crypto.getRandomValues` and fixes the original HTTP repro.
- `worker.py` currently uses `from js import Response, fetch` and a custom `handle(request, env)` function. This is NOT yet the Cloudflare `workers` SDK, native `.py` deploy support, workerd parity, Python Durable Objects, execution-limit qualification, or leak resistance.
- `docs/python-workers-plan.md` remains the original pre-implementation research snapshot; this file records newer execution evidence.

## Next action

1. Extend the now-tested host invalidation to pool retirement and prompt
   cancellation of suspended events. The initial patch rejects new calls and
   continuations when they next enter the isolate. A timer-backed suspended
   request is tested; a hung outbound operation does not yet have a dedicated
   invalidation wakeup. Do not silently retry the operation that exceeded CPU.
2. Verify Durable Object recovery, retained input/output gates, and alarm retry
   state under invalidation before enabling a production Python deployment path.
   Inspect pool placement/retirement and Dynamic Worker ownership. V8 clears the
   isolate's termination flag, but Python's asyncio/native frames may still be
   abandoned. The fixture's post-termination diagnostic now confirms a stale
   `asyncio.tasks._current_tasks` entry: `PyodideTask pending`, with `handle`
   still shown as running at the infinite loop. Synchronous Python evaluation
   still works; the next async handler does not settle. This directly identifies
   leftover scheduler state, without proving all interpreter state is safe.
   Cloudflare SDK `DurableObjectContext.abort` similarly documents
   that immediate V8 unwinding can leave Python task state behind. Preserve DO
   durability/input/output gates under whole-isolate invalidation. Do not clear
   `_current_tasks`: native/Wasm state may also have been interrupted. The host
   needs a terminal-runtime contract before admitting another guest invocation,
   including already-suspended work, rather than guest-controlled health checks.
3. Measure cancellation, process RSS, proxy cleanup, and eviction, then audit and
   reuse the current Workers SDK entrypoint bridge before native packaging/DOs.

## Goal continuation results (2026-09-21)

- Pinned workerd `1.20260922.1` and Miniflare `5.20260921.0-alpha` are installed
  and locked. The real reference runs unchanged `worker.py` for HTTP, KV,
  outbound fetch, and error behavior. Parsed success JSON is identical. Python
  error type/message/status match; both full stacks are retained. Reference
  Python is 3.13.2 / Cloudflare Pyodide 0.28.2 with a historical `on_fetch`
  adapter and compatibility date 2025-06-01. Current SDK `fetch` remains future
  work. Evidence: `evidence/2026-09-21-differential.json` under the experiment.
- Minimized Wasm probe: sync and native async instantiation of a precompiled
  module pass on both engines. Native raw-byte compile/instantiate hangs in
  celld; workerd rejects Wasm code generation. The earlier broad synchronous
  facade has been replaced: the build extracts/verifies the dependency's
  sentinel into `sentinel.wasm`, and both modules use native async instantiation.
  The adapter only recognizes the exact pinned sentinel bytes for compile.
- `resources.test.mjs` uses a real Dynamic Worker with `getEntrypoint` CPU
  limits and external request deadlines; `resource-driver.js` disposes its
  stubs. 100 requests each allocate/release 16 MiB in one interpreter. Linear
  memory grows from 20 MiB to 35,323,904 bytes and then plateaus.
- CPU termination succeeds in 25–29 ms, replacement succeeds, but same-runtime
  reuse fails. Full qualification is intentionally RED, not blocked on user
  input. The task-local processes are cleaned up by the harness.
- Retained minimized Wasm evidence: `evidence/2026-09-21-async-wasm.json`.
  Retained CPU/memory failure and stale-task diagnostic:
  `evidence/2026-09-21-resources-failure.json` (latest interruption 30–31 ms).
- Commands: `npm run build`, `npm run test:smoke`, `npm run test:wasm`,
  `npm run test:resources`; `npm test` includes all suites and the known failure.

Keep tests meaningful and local. Retain exact failing evidence and next actions if a slice cannot finish in one run. Make coherent local commits. Public outreach and PR publication remain outside this recurring prompt.

## Native invalidation checkpoint (2026-09-21, supersedes the red gate above)

- Added host-owned, sticky invalidation for `python_workers`-enabled isolates
  when hard execution termination is consumed. Ordinary Python exceptions do
  not invalidate. The flag currently only enables this lifecycle behavior; it
  does not install an SDK or implement native Python deployment.
- New worker/DO events are rejected before running guest code. Delivery, poll,
  cancellation, and pending-event turns fail invalidated entries with storage
  installed, retaining the existing `fail_in_turn` durability-gate path.
- Real Dynamic Worker test: CPU limit stops the loop; a diagnostic call, two
  later calls, and a Python task already suspended in `asyncio.sleep` receive
  `Python runtime invalidated after execution termination; recreate the worker`.
  An explicit Python-side handshake proves the sleeping task started first.
  A fresh replacement succeeds. No guest state is reset or repaired.
- Full current suite: **12 test records pass**, no failures. This covers the
  current HTTP/workerd, compiled-Wasm, and Dynamic Worker resource probes, not
  the remaining SDK/deployment/DO requirements. Raw-byte Wasm compilation still
  stalls as recorded separately. Official unmodified v0.5.1 remains unsafe to
  reuse after termination; it does not enforce the new flag behavior.
- Source build needs explicit Rust 1.94.1 (installed default is older), and an
  override for the machine's missing local V8 mirror:
  `RUSTY_V8_MIRROR=https://github.com/denoland/rusty_v8/releases/download cargo +1.94.1 build -p celld`.
  Run tests with `CELLD_BIN` set to this worktree's `target/debug/celld`.
- Debug binary SHA-256: `c7d91408c9bbc8b6d6aeb17ab1f174b56b59f6aed8f2e072086bcc1f24c6702e`.
  Tested js.rs SHA-256: `3fcf84b0854cabacc9b09da1cd2ee051c740c63975066dc3bd058309710d7cc1`.
  Tested lib.rs SHA-256: `2464ed9a834d066c5150a526c6bbdd6b721269fd33a44efce00af1182df3bd00`.
  Evidence files under the experiment: `2026-09-21-native-resources.json`,
  `2026-09-21-native-differential.json`, `2026-09-21-native-async-wasm.json`.
- Pool retirement, immediate invalidation wakeups, DO durability, proxy cleanup,
  and eviction are still unqualified. Existing suspended contexts fail only
  when driven again. The host guard must survive future native packaging and
  old-node capability rejection rather than relying on an ignored flag.
