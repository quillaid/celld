# Python Workers progress

## Mandate

Autonomous local implementation and validation through 2026-10-05 19:22 America/Los_Angeles. Worktree: `/Users/kylekelley/.codex/worktrees/celld-python-workers/celld`; branch `quod/python-workers`; base v0.5.1 `42269c1`. The detailed scope and gates are in `docs/python-workers-plan.md`. Monty is a separate project and out of scope.

Recurring continuation: `build-python-workers-for-celld`, every four hours until 2026-10-06 02:22 UTC. Only meaningful milestone/blocker notifications. Work locally, retain evidence, commit coherent verified increments. No live fleet deployment, release/merge, or upstream outreach.

Kyle explicitly requested `/goal`; the durable goal is ACTIVE with no token
budget. See `GOAL.md` and the goal tool. Continue immediately while there is
authorized work; do not wait for the heartbeat to make progress.

## Current slice — released SDK integration and native packaging

Pinned upstream Pyodide 0.28.3 runs through real celld HTTP, bindings, and a fixture-only Python Durable Object class bridge. Host termination, pool replacement, and focused Durable Object recovery are implemented and tested below. A separate fixture now loads the released Workers SDK unchanged and compares it with workerd. Native Python deployment remains future work; neither fixture is a supported deployment interface.

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

1. Audit and integrate the actual Workers SDK entrypoints and package contract;
   add native Python build/deploy/dev inputs. The fixture bridge is not a
   supported programming interface. Pin a reference contract before extending it.
2. Extend lifecycle qualification to alarm retries, remote I/O cancellation,
   process RSS/proxy bounds, eviction, and remote acknowledged-write durability
   with ownership changes. Local SQL, basic alarms, crash restart, and focused
   abort/input-gate recovery now pass; they prove only those tested paths.
3. Extend RPC, streaming, WebSocket, and binding coverage against the plan's
   compatibility matrix. Keep whole-isolate invalidation after hard termination;
   never attempt recovery by clearing Python scheduler state alone.

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

## Suspended events and pool retirement checkpoint (2026-09-21)

- Strengthened the suspended Python test to wait 60 seconds rather than one.
  The preceding build fails the explicit 2-second invalidation deadline. The
  retained red evidence is `evidence/2026-09-21-suspended-invalidation-failure.json`.
- Invalidation now broadcasts a host notification. Each in-flight request
  subscribes before checking the sticky terminal state, avoiding a lost wakeup.
  It stops listening once it has handled invalidation so pending output gates
  can settle on their ordinary path rather than spin on a ready notification.
- The 60-second Python sleeper now rejects around the 25 ms CPU cutoff (28–30 ms
  in the first passing capture). Native operation cleanup remains in the existing
  driver. This tests timer-backed suspension, not remote I/O transport teardown.
- Pool slots mark themselves retiring after observing terminal runtime state.
  Existing affiliations keep the heap alive to fail through normal event gates;
  new placement skips it. No user operation is retried automatically.
- `pool-lifecycle.test.mjs` starts actual Python interpreters in a pool capped at
  one active stateless isolate, then repeatedly terminates Python through a
  fixture-only FFI capability to `globalThis.process.exit(1)`. Five distinct
  interpreter IDs serve successfully across repeated replacement. This validates
  pooled hard termination; the Dynamic Worker test separately validates CPU
  cutoff. Top-level HTTP does not currently expose the per-call CPU limit knob.
- The named `node:process.exit` export is still a celld unsupported stub; the
  existing host-implemented global method is used deliberately in this fixture.
  Fixing that separate node compatibility gap is outside this slice.
- Tested debug binary SHA-256:
  `759dcfc53adbd23ea6a904ba86f58ad408bdddf229b5b5b9b40b875e571d49a2`.
  Full suite: 13 records passed, zero failures; formatting and diff checks pass.
  New evidence uses the `2026-09-21-retirement-*` prefix under `evidence/`.
  Remaining work includes DO recovery and gate retirement, transport cancellation,
  resource bounds, SDK/packaging, and the full compatibility matrix.

## Python Durable Object recovery checkpoint (2026-09-21)

- `durable.py` implements a SQL counter through the actual celld context. Its
  JS class bridge keeps one Python instance per Durable Object and reuses the
  interpreter per isolate. Two objects share an interpreter but maintain separate
  SQL values and Python instance IDs. This is fixture-only, not a Workers SDK.
- The initial abort test failed: all later requests reached the invalidated heap.
  `RuntimeInvalidated` now carries the heap identity from the host to the decision
  core. The core quiesces affected objects and uses its bounded runtime-swap path,
  preserving ownership epochs and waiting for existing safe-point/output gates.
  The host reports invalidation even if a generation change already retired the
  slot. Old heap observations are discarded once no cell/start can reference them.
- The stronger test failed after a sibling's abort interrupted Python inside
  `blockConcurrencyWhile`: the request returned an error, but a held input gate
  kept its event alive and prevented recovery. Terminal-entry cleanup now retires
  host input-gate and cross-entry claims without calling guest code. It retains
  the existing `fail_in_turn` path for storage/output-gate accounting.
- Real HTTP tests pass for independent increments, abort/recreation, a Python
  callback holding a concurrency block while a sibling aborts, and recovery of
  both objects with their previously acknowledged SQL values intact. A local
  HTTP handshake verifies the block has started and remains pending before abort.
- The decision-core test verifies same-epoch stop/start of both affected objects
  and leaves an unrelated heap resident, both before a generation announcement
  and when the invalidated objects already use the current generation.
- Validation: full integration suite 14 records passed; the extended final DO
  check passed again; one decision-core test passed. Rust formatting/diff checks
  pass. Build uses Rust 1.94.1 and the official V8 mirror override recorded above.
- Debug binary SHA-256:
  `d556506bdd208c512a5ec8a6df6e02aa9c171c733476ec6f5cec1ba2385a04f2`.
  Evidence: `2026-09-21-durable-recovery.json`, `durable-build.sha256`,
  `durable-core-test.txt`, `durable-differential.json`, and `durable-resources.json`
  (all names have the date prefix, under the experiment's `evidence/`). Both
  earlier DO failures remain as `durable-recovery-failure.json` and
  `durable-input-gate-failure.json`, also date-prefixed.
- Still unqualified: actual Workers SDK, alarms, transactions/rollback,
  process restart, remote acknowledged-write durability, multi-node ownership,
  memory/proxy bounds, full event/binding matrix, and native packaging/dev flow.
  The new local recovery proof does not establish those requirements.

## Transactions, alarms, and process crash checkpoint (2026-09-21)

- Python SQL rollback exposed an existing host incompatibility: public
  transactionSync passed a transaction view to a callback that takes no arguments.
  Corrected that contract and kept internal Workflow transaction views private.
- A pinned workerd comparison then exposed nested root transactionSync calls
  attempting a second top-level transaction. The host now tracks synchronous
  transaction views per I/O context, using savepoints for nested calls. Both
  engines return zero callback arguments, return value 42, and only the outer
  inserted row after an inner rollback. Both initial failures are retained.
- Existing JavaScript Workflow regression exercises waitForEvent/sendEvent and
  a persisted step to completion; it covers the internal transaction-view users.
  This is not a Python Workflow compatibility claim.
- Actual Python Durable Objects pass intentional rollback, ten concurrent
  increments, and alarm delivery. After eleven increments and another alarm are
  acknowledged, the test kills the supervisor and its separately supervised node,
  restarts on identical local storage, and verifies all values and the pending
  alarm. Interpreter and Python instance IDs both change.
- The first restart probe failed because celld dev's node has a separate process
  group. The harness now captures only descendants of its own live supervisor,
  kills both on a crash, waits for exit, and then reuses its store/listener. This
  harness failure is retained separately from runtime failures.
- Full integration suite: 17 test records passed, zero failures. Rust formatting
  and diff checks passed. Tested debug binary SHA-256: `23282b741d61489c41a880dfcc0a8492d17b05d091c5d6d4fe6b8741ae4f0292`.
  Evidence files use the date prefix with persistence-passing.json,
  transaction-contract-passing.json, persistence-full-suite.txt, and
  persistence-build.sha256 under experiments/python-workers/evidence/.
- This qualifies persistent local dev storage only. Remote durability, multi-node
  ownership, alarm retries, SDK/native packaging, and resource/transport bounds
  remain open; the goal is active.

## Released Workers SDK checkpoint (2026-09-21)

- Audited workers-py source at e5cf461540e94f2065398ced7ed8031ac504dc3a
  and pinned the released workers-runtime-sdk 1.9.0 wheel by SHA-256. The old
  workerd package explicitly describes itself as legacy. Details and source
  links are in experiments/python-workers/SDK_AUDIT.md.
- New SDK fixture loads the unmodified wheel into celld Pyodide. It uses actual
  WorkerEntrypoint, Request, Response, environment wrappers, and waitUntil.
  Background awaitable ownership is retained before returning to Python and
  released on settlement. Unsupported helper operations fail explicitly.
- Same Python source and wheel files run in pinned workerd. Both engines hash
  the loaded entrypoints.py and match the wheel's digest. JSON/status/headers,
  binary bytes, and eventual background KV writes pass. Workerd still uses the
  historical 2025-06-01 envelope and on_fetch dispatch alias; not latest parity.
- npm run build now prepares both fixtures, with cached SDK hash verification.
  npm test includes the SDK comparison. Full suite: 18 records passed, no
  failures. Evidence: 2026-09-21-sdk-passing.json and sdk-full-suite.txt under
  the experiment evidence directory (both date-prefixed).
- Next: turn the fixture bridge into generic SDK entrypoint/class adapters and
  native Python deployment packaging. Module-level env/import hooks, package
  startup patches, SDK DO bridge, and modern reference dates still need work.
  Goal remains active; no native packaging or broad SDK parity claim.

## Reusable SDK dispatch checkpoint (2026-09-21)

- Removed the celld-specific dispatch function from application Python source.
  `sdk-runtime.js` loads normal modules under `/app`; `sdk-dispatch.py` validates
  a selected WorkerEntrypoint subclass, creates a per-request instance, awaits
  async results when needed, and uses the SDK's RPC argument/result converters.
  Loader and invocation proxies have explicit release paths; long-run proxy
  bounds are still unqualified.
- Same-source workerd comparison now includes eight concurrent requests with
  instance-local state, an intentional Python exception, successful recovery,
  and a celld traceback naming `/app/worker.py`, alongside earlier SDK checks.
- The first expanded full run exposed a harness timing issue: it awaited
  reference startup before consuming celld's transport response, allowing the
  existing 10-second transport deadline to expire. Consume/buffer the response
  before reference dispatch; no deadline or runtime assertion was loosened.
  The failed run is retained as sdk-dispatch-harness-failure.txt.
- Full integration suite passes all 18 records. Passing SDK results and TAP are
  retained as sdk-dispatch-passing.json and sdk-dispatch-full-suite.txt. All three
  evidence names carry prefix 2026-09-21- in experiments/python-workers/evidence/.
- Next: native Python build/dev/deploy packaging and generated exports around
  this adapter, plus SDK module-level hooks and Durable Object adapters. Current
  application modules are real Python imports, but packaging remains experimental
  and explicit flat .py modules only. The overall goal remains active.
