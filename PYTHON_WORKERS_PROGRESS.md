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

## Python deployment lifecycle requirement (2026-09-21)

- Build now emits `python-lifecycle-v1` for deployments with the `python_workers`
  compatibility flag. This gates host invalidation, cleanup of suspended work,
  and heap replacement. It deliberately does not describe SDK/package support.
  Previously these bundles required Wasm but could reach a host without safe
  interpreter retirement.
- The current feature list recognizes that requirement. A deployment unit test
  builds both flagged and ordinary JS projects, checks the emitted requirement,
  verifies current-loader acceptance, and verifies unknown-version rejection.
- Inspected baseline v0.5.1 source: the new capability is absent from its supported
  set and its existing manifest gate rejects unknown requirements. This is source
  evidence of older-node rejection, not an older-binary fleet replay.
- Rebuilt the binary and ran the full real-runtime integration suite: 18 records
  pass. Deployment unit test passes, formatting and diff checks pass. Evidence:
  2026-09-21-python-manifest-test.txt, python-feature-suite.txt, and
  python-feature-build.sha256 (all date-prefixed) in experiment evidence/.
- Native `.py` build inputs and runtime/package metadata are still next. The new
  feature requirement closes an existing deployment gap but does not implement
  native packaging, dependency resolution, or newer SDK/runtime semantics.

## Native Python build path (2026-09-21)

- `.py` main files now take a dedicated branch in celld's existing build flow.
  The builder executable defaults to `celld-python-build`; the current local
  implementation is experiments/python-workers/build-project.mjs, selected by
  CELLD_PYTHON_BUILD. It is experimental and not published/installed globally.
- The helper collects importable source modules below the entry directory,
  generates the SDK entry wrapper, and emits JS/Wasm plus a schema-1 runtime
  descriptor. Celld validates the descriptor and Wasm hashes, retains runtime
  metadata before hashing deployment identity, and uses existing dev/publication
  paths. The python_workers flag is required, retaining the lifecycle feature
  requirement. No fleet publication was performed.
- Runtime bytes are verified against committed runtime-lock.json; SDK wheel
  verification remains pinned by sdk-lock.json. SDK download can occur during
  build if its cache is absent. Runtime startup uses only bundled local assets.
- Actual `celld dev` serves an SDK response from a two-module Python project.
  Dry-run builds of identical source in different temporary directories yield
  identical versions; changing source changes the version.
- Unsupported dependency manifests are rejected in the project root and source
  tree. Native DO/Workflow configuration and JS-specific no_bundle/define/rules
  are explicitly rejected while those paths remain unimplemented. This is an
  incomplete native packaging implementation, not a narrowing of the goal.
- Next: package resolution and lock semantics, source/import validation, generic
  class exports for SDK Durable Objects, and watched reload/rollback tests. The
  repository-local helper must also become a distributable tool. See README's
  native section for current invocation and exact limitations.
- Checkpoint validation: full integration suite 20 records passed, deployment
  unit test passed, Rust formatting/diff checks passed. Evidence uses prefix
  2026-09-21-native-: python.json, identity.json, full-suite.txt,
  manifest-test.txt, and build.sha256 under experiments/python-workers/evidence/.

## Syntax validation and watched reload (2026-09-21)

- Native builds now compile every collected application source with the pinned
  target CPython before bundling. They do not execute top-level application
  code or invoke the machine's Python. The deployment check explicitly verifies
  that a top-level RuntimeError is not executed, while invalid syntax fails.
- The first reload test exposed unusable error reporting: an uncaught Pyodide
  error made Node print its minified loader before the Python traceback, which
  was truncated from the dev log. The helper now reports the exception message
  directly. Retained evidence: reload-diagnostic-failure.json (date-prefixed).
- Actual watched dev reload adopts a changed local Python module, retains the
  working deployment after a syntax error, and adopts a corrected edit. The
  test waits for the new node readiness signal on successful reloads.
- A full-suite run observed a connection drop while dev stopped/restarted its
  node for a valid edit. This is a measured availability gap, not hidden parity:
  source confirms dev's existing stop/start implementation. Retained evidence:
  reload-restart-window.json (date-prefixed). Readiness-based checks verify
  adoption; the broken-edit check still directly requires the old code to serve.
  No zero-downtime development reload is claimed.
- Missing-import checks, package resolution, native DO exports, remote durability,
  and the remaining objective are still open. Continue those next.
- Final validation: all 21 integration records passed; diff checks passed.
  Evidence: 2026-09-21-reload-passing.json, syntax-build.json, and
  reload-full-suite.txt (all date-prefixed) under the experiment evidence/.
  The tested celld binary is unchanged from the native-build checkpoint.

## Build-time module import inspection (2026-09-21)

- Extracted target-Python validation into validate-sources.py. Builds now inspect
  unconditional top-level module imports, reject absent bundled local modules
  and submodules with a filename/line diagnostic, and validate source module
  paths before mounting them.
- The validator mounts the pinned SDK for lookup and walks module specs without
  importing application packages. Regression checks include a package initializer
  that raises if executed, nested namespace packages, missing root/submodules,
  and an optional import inside try/except that must remain accepted.
- Qualified PathFinder lookup initially failed for nested namespace packages
  because its parent was deliberately absent from sys.modules. Walk individual
  components within their search directories instead. Retained failing evidence:
  2026-09-21-import-namespace-failure.txt under experiment evidence/.
- This is deliberately bounded inspection, not full dependency resolution.
  Conditional/function-local/dynamic imports and imported attributes are not
  resolved. Standard-library roots are recognized without asserting availability
  of every compiled extension or virtual child. Those gaps remain in scope.
- Next substantial work: native SDK Durable Object exports and package locks/
  resolution, then the remaining lifecycle/binding matrix. The goal stays active.
- Final suite: 21 integration records passed with existing deadlines unchanged.
  One earlier full run timed out in the SDK case before its first comparison;
  an isolated rerun and the instrumented full rerun passed. Its cause remains
  unproven. The failed run is retained as import-suite-sdk-startup-timeout.txt;
  SDK phase timestamps now distinguish celld body completion from workerd
  response arrival if it recurs. Passing evidence: import-build-passing.json,
  import-sdk-phases.json, import-full-suite.txt. All evidence has the
  2026-09-21- prefix under experiments/python-workers/evidence/.

## Native SDK Durable Object exports (2026-09-21)

- The Python builder receives configured user DO class names from celld and
  generates named JS class exports. Runtime initialization is shared between
  default Worker and DO exports in each isolate; each DO constructor retains
  a dispatcher closing over its own actual SDK DurableObject instance. Fetch
  and alarm use the SDK argument/result converters. Native Workflow exports,
  other event/RPC exports, and long-run proxy reclamation remain unqualified.
- Same-source native fixture now runs through real celld and pinned workerd:
  SQL updates, transaction rollback, SDK abort recovery, and alarm delivery.
  Both use workers-runtime-sdk 1.9.0. Workerd uses the historical 2025-06-01
  envelope with on_fetch/on_alarm aliases. Celld also preserves SQL and alarm
  counts across killing/restarting its test-owned supervisor and node.
- SDK abort initially returned an exception but left the object instance alive.
  A focused differential showed celld's queueMicrotask fallback passed one
  argument while workerd passed zero. Python's scheduled zero-argument abort
  callback could not run. Corrected the fallback to invoke the callback without
  Promise arguments. The unchanged SDK then passes abort/recreation.
- Retained red evidence: 2026-09-21-native-sdk-abort-failure.json and
  2026-09-21-microtask-arity-failure.json in experiments/python-workers/evidence/.
  This is a callback arity fix, not qualification of every queueMicrotask semantic.
- Package resolver/distribution, modern compatibility dates, broader events,
  remote durability/ownership, and the rest of the original goal remain open.
- Full suite with two file jobs: all 23 records passed. Added SDK identity and
  reference instance-recreation assertions then passed in the focused native DO
  rerun. The loaded workers.entrypoints digest matches the pinned wheel in both
  engines. Deployment unit test and formatting/diff checks also pass.
- An unbounded-file run timed out in SDK reference startup. Phase evidence shows
  celld returned its body in about one second; workerd's first response did not
  arrive before the unchanged test deadline. The default suite now bounds file
  parallelism to two; individual concurrency probes/deadlines remain unchanged.
  Root cause of the reference delay is not established.
- Passing evidence: native-sdk-durable-passing.json, microtask-arity-passing.json,
  native-do-full-suite.txt, native-do-identity-test.txt, native-do-build.sha256.
  Timeout run/phase evidence is also retained. All use the 2026-09-21- prefix
  under experiments/python-workers/evidence/. No fleet or public changes.

## SDK response streaming checkpoint (2026-09-21)

- Same Python source now produces a TransformStream-backed SDK Response while
  ctx.waitUntil retains its producer. The producer writes a prefix, awaits a
  held loopback HTTP request, then writes the suffix and closes the stream.
- The client must receive the prefix before releasing the HTTP gate; a pending
  next read verifies the suffix is unavailable until release. Both engines must
  then produce identical bytes. Prefix collection allows transport chunk splits.
- Initial reference runs stalled while celld streamed successfully. Instrumented
  evidence showed workerd had reached the HTTP gate and returned headers with
  mf-content-encoding: gzip, but its compressed tiny prefix had not reached the
  client. Explicit Accept-Encoding: identity makes this a deterministic test of
  incremental uncompressed delivery. Both engines pass that contract; this does
  not assert gzip flush parity. Red observations remain in stream-handshake-stall
  and stream-compression-buffering JSON evidence, both date-prefixed.
- No production runtime change was needed for this response-stream path. Upload
  streaming, cancellation, compression behavior and large-stream resource limits
  remain unqualified, alongside the other outstanding goal requirements.
- Final targeted SDK suite passed all its HTTP, exception, concurrent request,
  binary, background KV, SDK identity and streaming assertions. Evidence:
  2026-09-21-sdk-streaming-passing.json and sdk-streaming-test.txt (both
  date-prefixed) under experiment evidence/. Diff checks pass. The runtime
  binary is unchanged from the native DO checkpoint; unrelated suites were
  not repeated for this fixture-only change. Goal remains active.

## SDK upload streaming checkpoint (2026-09-21)

- A real HTTP upload sends a prefix and keeps the request open. The same Python
  SDK application echoes request.body; the client must receive that prefix
  before sending the suffix and closing. Workerd passed while celld returned
  HTTP 500: the unchanged SDK rejected constructor.name CelldHttpBodyStream.
  The failing response and successful reference are retained in
  experiments/python-workers/evidence/2026-09-21-sdk-upload-failure.json.
- Both internal HTTP and buffered body stream prototypes now expose the
  standard ReadableStream constructor. Their specialized read/tee behavior and
  prototype chains remain intact. No SDK patch or body buffering was added.
- The targeted SDK suite now passes incremental upload echo and small buffered
  request-body echo on both engines, alongside existing response streaming,
  request isolation, exception, binary and background-work checks. Reference
  Python still uses the historical 2025 compatibility envelope.
- Cancellation, compression flush behavior, sustained stream memory pressure,
  package support and the other original goal requirements remain open.
- Rebuilt the native binary and passed all 23 records in the full experiment
  suite with two file jobs, plus the focused SDK run. Diff checks pass. Retained
  date-prefixed sdk-upload-passing.json, sdk-upload-test.txt,
  sdk-upload-full-suite.txt and sdk-upload-build.sha256 under evidence/.
  No fleet or public changes; the goal remains active.

## SDK response cancellation checkpoint (2026-09-21)

- The real HTTP client reads a prefix, aborts its connection, then releases the
  Python TransformStream producer's held HTTP gate. The producer must observe
  rejected writes before completing a bounded 16 MiB payload. Its finally block
  releases the writer and reports through a separate HTTP request.
- Both celld and the pinned historical workerd reference pass. Stage evidence
  distinguishes write rejection from a failure fetching the release gate.
  Error strings and accepted write counts differ; those are recorded, not
  asserted as identical. Both engines serve a normal request afterward.
- The final focused SDK suite passes, including prior upload/response streaming,
  exception, concurrency, SDK identity, binary and background-work assertions.
  Evidence: date-prefixed sdk-cancellation-passing.json and
  sdk-cancellation-test.txt under experiments/python-workers/evidence/.
- No production runtime change was needed. The binary remains the one qualified
  by the previous 23-record full suite; unrelated tests were not repeated for
  this fixture-only checkpoint. Diff checks pass.
- This proves cancellation of a waitUntil-retained response producer and its
  Python finally path, not proxy reclamation, RSS bounds, upload cancellation,
  or cancellation without waitUntil. Those and the original remaining package,
  compatibility, event/binding and multi-node requirements remain open.

## SDK upload disconnect checkpoint (2026-09-21)

- An unfinished chunked HTTP request sends six bytes. Python acknowledges those
  bytes through a separate callback before the client destroys its socket.
  A task retained with waitUntil continues reading the body and records the
  resulting read exception, then releases the reader and reports from finally.
- Both celld and the historical workerd reference reject from read(), report
  exactly six bytes consumed, and serve a normal follow-up request. Error text
  differs, as recorded in evidence; no exact-message parity is claimed.
- The focused SDK suite passes all existing cases and this new probe. No runtime
  changes were required, so the native binary remains the previously qualified
  one. Evidence: date-prefixed sdk-upload-cancellation-passing.json and
  sdk-upload-cancellation-test.txt under experiments/python-workers/evidence/.
  Diff checks pass; no unrelated full suite rerun for fixture-only changes.
- Abrupt upload and response disconnects now have differential cleanup evidence.
  Application-driven cancellation, cancellation without retained tasks, resource
  reclamation/pressure, package resolution and the other original goal gates
  remain open. Goal remains active, with no fleet or public changes.

## Target package resolver groundwork (2026-09-21)

- Added lock-packages.mjs: resolves one pyproject.toml project.dependencies list
  or simple PEP 508 requirements.txt inside pinned Pyodide 0.28.3 / CPython
  3.13.2, using its micropip 0.10.1 wheel. Resolver/runtime bytes are verified
  before use. The local uv only advertises the older Pyodide 2024 target and was
  not used for this 2025_0 ABI.
- The lock binds the input manifest hash, target ABI, resolver identity, roots,
  selected transitive package closure, wheel origins, versions and hashes.
  Verified wheel bytes are cached by digest under project .celld/python-wheels.
  A successful resolution atomically replaces the lock; failures preserve it.
  Current acceptance is pure Python wheels. Compiled PyEmscripten packages and
  their shared-library loader remain a later explicit gate.
- Tests cover PyPI humanize 4.12.3, runtime-index python-dateutil 2.9.0.post0 and
  transitive six 1.17.0. Identical inputs produce identical locks; marker tests
  select Emscripten and skip a deliberately nonexistent macOS-only requirement.
  Locked wheel bytes import and execute formatting/date parsing in target
  CPython with fetch disabled. Corrupt caches and dynamic dependencies reject.
- The conflict test exposed micropip accepting incompatible six==1.17.0 and
  six==1.16.0 roots. Added independent installed-metadata validation of root and
  transitive requirements, extras/markers and Requires-Python; frozen versions
  must match those verified installed versions. The conflicting lock now fails
  without replacing the old lock. Raw failing test evidence is retained.
- Native dev/deploy STILL rejects dependency manifests. Next work: consume this
  lock in the native builder, validate manifest/hash/ABI staleness, mount packages
  for static import checks and runtime startup, include identity in deployment
  metadata, then qualify real HTTP, offline startup, identity changes and reload.
  This utility is groundwork, not completed deployed package support.
- Final npm run test:packages passes; diff checks pass. Evidence includes
  date-prefixed package-resolver-passing.json, package-resolver-test.txt and
  package-conflict-failure.txt under experiments/python-workers/evidence/.
  No celld runtime changed, so its unrelated HTTP suites were not rerun.
  Goal remains active; no fleet/public changes.

## Native locked-package integration (2026-09-21)

- Native Python dev/deploy now accepts a dependency manifest with a matching
  celld-python.lock.json. The host passes the project root to the builder so
  nested source entries use the root manifest. Unsupported requirements-file
  variants still reject explicitly.
- consume-packages.mjs verifies the manifest digest, pinned Python/Pyodide ABI,
  closed dependency references, pure-wheel filenames and artifact hashes. It
  downloads only missing locked artifacts during builds; it never resolves new
  versions. Corrupt cache bytes fail rather than silently being replaced.
- The target interpreter validates wheel paths/layouts before unpacking: no
  traversal, symlinks, duplicate files, SDK shadowing, .data relocation or .pth
  hooks. Packages are mounted for static import inspection and bundled as bytes
  for SDK runtime initialization, ahead of application import. No request-time
  package download path is introduced.
- Runtime metadata includes the lock and its digest in deployment identity.
  A relocation test caught local cache paths leaking through esbuild comments
  into that identity. Virtual modules now use wheel hashes and the verified
  in-memory bytes. The same project in different directories produces the same
  version; changing humanize 4.12.3 to 4.12.2 produces a different version.
- Focused native package test passes real celld HTTP using humanize, dateutil
  and six, plus startup of the generated bundle with global fetch disabled.
  It also covers a nested entry, repeatable/relocated identity, stale manifest,
  wrong ABI and corrupt artifact rejection. The existing unlocked-manifest
  regression now expects the missing-lock diagnostic.
- Package watch/reload, compiled PyEmscripten extensions, broader wheel layouts,
  startup hooks, framework/SDK companion modules and distribution remain open,
  along with the original resource, event and multi-node qualification gates.
- All 24 records in the rebuilt full HTTP suite pass, as does the Python
  deployment capability unit test and diff check. Retained date-prefixed
  native-packages-passing.json, native-packages-test.txt,
  native-packages-full-suite.txt, native-packages-unit-test.txt and
  native-packages-build.sha256 under experiment evidence/. The relocation red
  case is package-path-identity-failure.txt. No fleet/public changes; goal active.

## Package reload and workerd comparison (2026-09-21)

- package-reload.test.mjs watches an actual native Python project. Updating
  requirements without its lock produces the stale-lock diagnostic and keeps
  serving humanize 4.12.3. A wrong-ABI lock also leaves the good Worker running.
  Publishing the matching valid lock serves 4.12.2; restoring the original
  manifest/lock restores 4.12.3. Every observation checks formatting behavior
  and the installed package metadata version, not just a ready log line.
- package-reference.test.mjs runs identical SDK Python against celld and the
  pinned historical workerd reference. The same humanize/dateutil/six wheel
  bytes, verified by hash, are bundled/unpacked by celld and exposed as zip
  imports by the reference. Results, package versions and the unchanged SDK
  source digest agree. This is application behavior parity, not parity with
  Cloudflare's package resolver or current compatibility date.
- New package cache entries are written to unique temporary files and atomically
  renamed after verification. Cache hits verify without rewriting. This avoids
  exposing partial writes to concurrent build processes; corrupt cache contents
  still reject. No change to runtime dispatch or the native binary was needed.
- Both new tests pass individually and together with two file jobs, and are now
  in the default HTTP suite. The earlier 24-record full-suite result remains the
  runtime regression baseline; no new full-suite result is claimed here.
- Compiled extensions, framework/package hooks, distribution, broader events
  and the original resource/multi-node qualification requirements remain open.
- Resolver tests also pass after the cache-write change, including corrupt cache
  and conflicting requirement rejection. Diff checks pass. Date-prefixed
  package-reload-passing.json, package-reference-passing.json,
  package-lifecycle-test.txt and package-lifecycle-resolver-test.txt are retained
  under experiment evidence/. Goal active; no fleet/public changes.

## First compiled Python extension (2026-09-21)

- Package resolution/consumption now accepts the exact
  cp313-cp313-pyodide_2025_0_wasm32 wheel tag in addition to pure wheels. Native
  WHEEL metadata must contain the target tag; extracted .so files must be Wasm.
  Existing path/layout/collision checks remain in place.
- The builder extracts .so bytes, validates them with the build-time Wasm
  compiler, and emits content-addressed immutable Wasm modules. The deployment
  descriptor includes their paths, module names and SHA-256 digests. Celld checks
  module names against those digests and verifies bytes before including them.
  Host unit tests reject changed bytes, path-like names and malformed digests.
- The lexical async Wasm compiler matches exact wheel-library bytes to compiled
  imports. The SDK initializer unpacks wheels, then preloads library paths with
  pinned Pyodide 0.28.3's private _api.loadDynlib hook before importing the app.
  This does not repair the separate generic raw-byte Wasm compile stall.
- A real native Python Worker calls MarkupSafe 3.0.2's compiled
  _speedups._escape_inner. The test requires its .so filename and builtin-function
  identity and checks escaped results, preventing the pure-Python fallback from
  satisfying the test. Generated-bundle startup with global fetch disabled also
  executes the C function successfully.
- One native extension is qualified on celld, not the compiled-package matrix.
  Workerd comparison, multi-library graphs/shared-library archives, extension
  reload, NumPy-style workloads and resource pressure remain open. The loader
  hook must be re-audited when the pinned runtime changes. Other original goal
  requirements remain intact; no fleet/public changes.
- Rebuilt the native binary and fixtures. All 27 records in the full HTTP suite
  pass, plus both Python deployment unit tests and diff checks. Evidence includes
  date-prefixed native-extension-passing.json, native-extension-test.txt,
  native-extension-full-suite.txt, native-extension-unit-test.txt and
  native-extension-build.sha256 under experiment evidence/. Goal remains active.

## Compiled-extension workerd comparison (2026-09-21)

- The first reference probe rejected PythonRequirement modules: the pinned
  workerd reports that format is no longer supported. Inspected its current
  source at c22e7ae3b5e2fc5fc1cf382eee0110550497668d and identified compilation
  from trusted read-only filesystems. This source revision is provenance for
  the investigation, not a claim that it built the pinned workerd binary.
- Mounting extracted wheel files as Worker Data modules lets the reference load
  the extension through that read-only path. Extended native-extension.test.mjs
  now runs identical Python and the unchanged SDK in both engines, compares C
  function outputs, and verifies the actual loaded .so and SDK source digests.
- ASCII, BMP Unicode and astral Unicode cases pass with matching builtin-function
  identity and output. Only module filesystem paths differ and are normalized;
  both must still name the compiled .so. The celld offline-startup check remains
  in the same test. Native servers are closed before starting the reference to
  bound simultaneous interpreter startup pressure.
- Final focused test passes. No runtime/binary changes were needed, so the prior
  27-record full suite and host unit evidence remain the regression baseline.
  Retained evidence: date-prefixed extension-reference-passing.json,
  extension-reference-test.txt and obsolete-python-requirement.txt in experiment
  evidence/. Diff checks pass.
- This is workerd 1.20260922.1 with the historical 2025-06-01 Python envelope,
  not current-date, package-resolver or snapshot parity. Multi-library graphs,
  shared-library archives, extension lifecycle/pressure and the other original
  SDK/event/durability/distribution requirements remain open. Goal active.

## Native Python Durable Object method RPC (2026-09-21)

- The initial same-source workerd comparison returned 200 while celld rejected
  RPC because the generated class did not extend the host DurableObject base.
  The adapter now extends that base and installs methods within the object's
  blockConcurrencyWhile initialization gate before RPC lookup can proceed.
- Python dispatch uses the SDK python_from_rpc/python_to_rpc conversion and
  retains each object's own instance. Descriptor inspection avoids evaluating
  properties. Ordinary and inherited functions, static/class methods, and
  constructor-installed functions are discovered; host-reserved and dunder
  names remain excluded. Handler proxies remain private host fields.
- A second red comparison disproved the proposed public-method-only boundary:
  workerd accepts leading-underscore methods. The adapter now includes them.
  Both original failures are retained in date-prefixed native-rpc evidence.
- Focused differential checks pass for sync/async calls, nested values, inherited
  and underscore methods, static/class methods, constructor-installed functions,
  Python exceptions and recovery, eight concurrent calls, two independent object
  identities, and SQL state after a celld process crash. Reference uses workerd
  1.20260922.1, the unchanged 1.9.0 SDK wheel, and the historical 2025-06-01 Python
  envelope with Default.on_fetch alias. No current-date parity claim.
- This is a bounded method bridge, not full RPC parity. Late-added methods,
  arbitrary callable descriptors, dunder/reserved names, properties, returned
  capabilities, service entrypoints, cross-node behavior and proxy reclamation
  still need qualification. The other original goal requirements remain open.
- Rebuilt fixtures; all 28 full-suite records pass with two test files at a time,
  including prior SQL/alarm/restart, package/offline/reload, termination, HTTP
  streaming and cancellation probes. No Rust changes were required. Focused and
  full-suite logs and passing RPC observations are retained under evidence/.
  Diff checks pass. Goal remains active; no public or live-fleet changes.

## Python Durable Object WebSocket events (2026-09-21)

- Previous goal turn made verified progress: commit 63342b7 added bounded method
  RPC and passed 28 suite records. This turn moves to the original WebSocket scope.
- Same-source Python upgrades failed on celld while workerd successfully exchanged
  Unicode text and binary input, a serialized attachment, and a clean close.
  The host WebSocketPair included an enumerable length property, so Object.values
  returned three entries. A small JS differential confirms the precise mismatch;
  removed that property and retained the original failure evidence.
- The next probe delivered text but failed on binary messages: SDK RPC conversion
  transformed the ArrayBuffer to a memoryview before calling the Python handler.
  Workerd's non-fetch lifecycle handlers use direct Pyodide FFI calls. The adapter
  now bypasses RPC conversion for alarm/WebSocket message/close/error arguments.
  Same-source text/binary/attachment/clean-close comparison now passes.
- Native fixture uses acceptWebSocket and async handlers; SQL records both message
  payloads and close metadata. The test additionally crashes celld after the clean
  close and compares its stored records after restart. This does not prove live
  connection survival across eviction, automatic hibernation, binary output,
  abnormal-close/error semantics, outgoing sockets, or cross-node forwarding.
- Reference: unchanged SDK 1.9.0 wheel, workerd 1.20260922.1, historical Python
  date 2025-06-01 with on_fetch/on_webSocketMessage/on_webSocketClose aliases.
  JS pair comparison uses 2026-09-21. API source consulted:
  https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/
  Pinned source investigation: c22e7ae3b5e2fc5fc1cf382eee0110550497668d,
  src/pyodide/python-entrypoint-helper.ts lifecycle dispatch branch; source pin
  is investigation provenance, not a claim about the binary's build revision.
- Rebuilt celld and fixtures. All 30 full-suite records pass with two files at a
  time, including native alarm/RPC, cancellation/streaming, packages/reload,
  termination and WebSocket process-crash persistence. Retained date-prefixed
  native-websocket/websocket-pair failure and passing JSON, full-suite log, and
  binary hash under evidence/. Diff checks pass. Goal remains active; all original
  unqualified lifecycle/distribution/SDK requirements remain in scope.

## Binary WebSocket replies and abrupt disconnects (2026-09-21)

- Previous turn was verified progress (7a4188c, 30 passing records). Extended the
  same Python fixture to return actual binary frames, with the client verifying
  byte-for-byte payloads rather than JSON representations. Binary output passes.
- Abrupt TCP termination exposed a host mismatch: workerd invokes on_webSocketClose
  with code 1006, reason "WebSocket disconnected without sending Close frame.",
  and wasClean=false. Celld instead invoked webSocketError. Retained the failed
  differential observation in evidence/2026-09-21-websocket-abrupt-failure.json.
- The reader previously discarded its error and collapsed all unclean exits.
  It now classifies fastwebsockets UnexpectedEOF as an unclean close, and carries
  an explicit is_error bit through PumpClose, the cell event and JS dispatch.
  Other existing failure paths keep their prior classification; no broad claim
  of protocol-error or outbound-socket compatibility. Close reasons are data,
  not used to choose the event handler.
- Focused Python comparison now passes binary output, clean close and abrupt EOF
  on both engines, alongside SQL persistence after a process crash. A host duplex
  transport test confirms EOF is a close while an illegal RSV1 frame remains an
  error even when immediately followed by EOF. Test passes.
- Found the existing internal /evict/<scope> endpoint for the next live-socket
  residency probe. No forced eviction has been qualified yet. Full original
  hibernation/ownership/distribution/resource/SDK requirements remain open.
- Rebuilt celld. All 30 full-suite records pass; the focused transport unit test
  also passes. Evidence retains failure/passing observations, focused/full-suite
  logs, unit output and the binary hash under date-prefixed websocket-abrupt and
  websocket-transport names. Diff checks pass. Goal active; no public changes.

## Python live-socket forced eviction (2026-09-21)

- Previous turn made verified progress (eb9f3a6): binary output/EOF differential
  plus transport regression and 30 full-suite records passed. This turn adds
  direct evidence for the original live-socket residency requirement.
- Added a native Python fixture with per-construction UUID, constructor-time
  getWebSockets count, distinct serialized attachments, tags, and SQL message
  count. The test uses only its isolated server's logged internal listener and
  /evict/<scope> endpoint, requiring each eviction to return 200.
- Two real TCP WebSockets survive three forced evictions of their shared Durable
  Object. Each next application message is handled by a new Python instance,
  the constructor recovers two sockets, attachments remain distinct, tags persist,
  and SQL counts continue. Both sockets report the same new instance per cycle.
- After one clean close, a fourth eviction restores just the survivor, retaining
  its attachment and SQL count. The final connection also closes cleanly. Focused
  test passes; nine acknowledged application messages and four successful
  evictions are retained in evidence/2026-09-21-socket-eviction-passing.json with
  the test log alongside it. No runtime changes were necessary. Prior 30-record
  regression result remains the baseline; the new test joins the default suite.
- This is local forced eviction, not a workerd eviction differential, automatic
  idle hibernation, pressure-driven interpreter eviction, auto-response no-wake
  proof, process survival of TCP sockets, or multi-node ownership migration.
  Those and other original goal requirements remain open. Goal active.

## Python socket auto-response without residency (2026-09-21)

- Previous turn made verified progress (875d791): two live sockets survived
  forced local eviction. Extended that fixture with a Python-installed
  WebSocketRequestResponsePair and explicit /state residency observations.
- Before each of three evictions, the Durable Object appears in the deployment
  generation census. After eviction it is absent. Both live sockets then receive
  pong for ping, and the object remains absent after each reply. Only the next
  application message restores residency and creates a new Python instance.
- The six automatic replies do not enter Python's message handler: SQL still
  contains only the nine application messages. Each socket's auto-response
  timestamp is initially absent and survives reconstruction with a value inside
  the test's observed ping/reply time window. Attachments/tags remain distinct and
  closing one socket before the fourth eviction still restores only the survivor.
- Focused test passes; no runtime changes. Evidence retained as date-prefixed
  socket-autoresponse-passing.json and socket-autoresponse-test.txt. Previous full
  regression baseline remains applicable; this is local residency/SDK proof, not
  automatic idle/pressure eviction or ownership migration. Goal remains active.

## Automatic idle hibernation with Python socket keepalives (2026-09-21)

- Prior turn was verified progress (89cc87f): forced eviction plus auto-response
  no-wake evidence. Added the automatic idle-policy variant using the existing
  CELLD_IDLE_EVICT_S=1 control. Source confirms this policy is disabled by default.
- Both forced and automatic tests now share socket-lifecycle-probe.mjs. The idle
  branch never calls /evict: it observes /state until the object is no longer
  resident, retaining the same reconstruction/attachment/tag/SQL/close checks.
- Matching ping/pong traffic continues every polling interval while waiting for
  idle eviction. In the passing run, 70 such replies did not pin the Python
  object; four automatic evictions were observed in roughly 1-2 seconds each.
  Six additional replies after dormancy retained the no-wake guarantee. Nine
  application messages alone reached Python/SQL. Each application wake creates
  a new instance, restores the expected connections and retains timestamps.
- Both focused lifecycle tests pass after the shared-helper change. No runtime
  modifications; prior full regression baseline remains applicable. Retained
  socket-idle-passing.json and socket-lifecycle-test.txt under date-prefixed
  evidence names. The new idle test joins the default suite.
- This qualifies the configured local idle policy, not default-policy changes,
  pressure eviction, process survival of live connections, workerd's eviction
  policy or cross-node ownership. Those and other original requirements remain
  open. Goal active; no public or fleet changes.

## Python allocation pressure and delayed recovery (2026-09-21)

- Prior turn was verified progress (0282e7a): configured idle hibernation while
  keepalives continue. This turn probes real allocation pressure using a native
  Python Durable Object, a 512 MiB node threshold and a retained 256 MiB bytearray.
- Celld observes the allocation through its allocator-adjusted process RSS,
  reports shedding=memory and evicts the object after acknowledging its SQL write.
  The first ten-second recovery request timed out. Retained that failed trace as
  native-pressure-recovery-failure.json rather than treating eviction as recovery.
- Investigation found an empty cell pool still holding its interpreter. The
  existing REAP_INTERVAL in runtime.rs is 30 seconds. During a follow-up probe,
  that maintenance pass reports the heap freed, active memory drops below the
  threshold, and pressure clears; a fresh Python instance reads the SQL write.
  No production behavior was changed to make the test pass.
- The fixture now separately asserts baseline below the threshold, observed
  memory shedding, object retirement, empty-heap reclamation and pressure clearing
  within the documented maintenance interval, then a ten-second HTTP recovery
  bound. The original low-latency recovery limitation remains explicit.
- This is macOS RSS-based pressure for one object. Linux cgroup behavior, shared
  populated heaps, live-socket pressure, repeated cycles, extension allocations
  and faster recovery remain open; other original goal requirements remain intact.
- Final focused pressure test passes with the explicit phase assertions. Retained
  native-pressure-passing.json and native-pressure-test.txt; the test joins the
  default suite. No runtime changes, so prior regression evidence remains the
  baseline. Diff checks pass. Goal remains active; no public/fleet changes.

## Prompt empty-heap reclamation after Python pressure eviction (2026-09-21)

- Previous turn was verified progress (456b9de) but retained a real ten-second
  recovery failure caused by waiting for the 30-second periodic reaper. This turn
  addresses that delay instead of accepting it as the final recovery contract.
- RuntimeManager::stop_cell now retains each stopped handle's generation, drops
  its residency after storage closure, then invokes the existing guarded
  reap_cell_pools policy. The policy excludes housed heaps; may_free additionally
  requires zero turns and requests. Contended pools retain periodic fallback.
  No admission limits, memory watermarks, deadlines or core policy were relaxed.
- Pressure probe now immediately issues its recovery HTTP request after observing
  retirement, with the original ten-second request deadline. It requires actual
  freed-heap census evidence before replacement admission. The first tightened
  run served correctly but checked freed too late: pool slots are reused, so that
  census is not a cumulative counter. The assertion now uses the pre-recovery
  snapshot, retaining the memory-release requirement.
- New shared-heap regression creates two Python Durable Objects, verifies one
  interpreter contains both, evicts the first and checks the second retains its
  UUID and heap. Evicting the last object must immediately report one freed heap.
  Focused shared-heap test passes. Native pressure fixture now routes named paths
  to separate objects for this test; its existing root name remains unchanged.
- Rebuilt celld; all 34 full-suite records pass, including forced and automatic
  live-socket hibernation, pressure, shared-heap preservation, CPU termination,
  SQL/alarm/restart and SDK comparisons. In this run, observed eviction to served
  recovery was 2092 ms. This is measured local behavior, not a universal latency
  guarantee; contended/active heaps still rely on safe later reclamation.
- Evidence retained: prompt-pressure-recovery-passing.json, shared-heap-passing.json,
  pressure-recovery-full-suite.txt and pressure-recovery-build.sha256 under the
  date-prefixed experiment evidence paths. Rust formatting and diff checks pass.
  Original delayed-recovery evidence remains. Goal active; no public/fleet changes.

## Shared-interpreter Python handler proxy cleanup (2026-09-21)

- Prior turn made verified progress (8e86812), with 34 full-suite records passing
  and prompt whole-heap recovery. A new WeakSet probe exposes a separate problem:
  evicting one of two Python objects retains its instance through the JS handler
  proxy even after Python gc.collect(). The census remained two rather than one.
  Retained the failing observation in proxy-lifecycle-failure.json.
- Host residency release now marks the old DurableObjectState as released using
  a JS boolean only. The SDK adapter tracks owned handler proxies and destroys
  released/aborted ones at its next invoke. Python __del__ can execute during
  proxy destruction, so it deliberately does not run from native teardown,
  including teardown after hard termination. Ordinary event admission and the
  existing invalidated-runtime gate remain responsible for guest entry.
- The focused shared-interpreter fixture keeps a witness object resident while
  repeatedly constructing/evicting a second object. The witness keeps its UUID
  and the Python WeakSet returns to one survivor after each of eight cycles.
  Added an exactly-once __del__ count for the final regression run.
- Cleanup is deferred until the next Python event if the heap remains shared;
  otherwise heap retirement frees it. This does not qualify returned RPC
  capabilities, retained exception tracebacks, adversarial finalizer behavior,
  or long-run memory bounds. All original goal requirements remain in scope.
- Rebuilt celld and fixtures. All 35 full-suite records pass, including eight
  cleanup cycles with live=1 and finalized=1..8, CPU termination, abort/restart,
  pressure/shared-heap recovery and socket hibernation. Date-prefixed evidence
  retains failure/passing proxy observations, full-suite log and binary hash.
  Diff checks pass. Goal remains active; no public or fleet changes.

## CPU-bounded Python finalization in Dynamic Worker facets (2026-09-21)

- Prior turn was verified progress (571a86e): handler proxy cleanup and 35 full
  regression records pass. This turn tests unbounded user work in __del__.
- Top-level native requests have no per-call CPU knob in this implementation.
  The fixture therefore loads the generated pinned SDK bundle through a real
  Worker Loader with WorkerCode.limits.cpuMs=3000 and mounts Counter as facets
  of a native parent Durable Object. It uses the actual adapter cleanup path.
- Unarmed control: construct, abort and reconstruct the victim facet; the same
  finalizer completes exactly once. Armed case: the same instance then enables
  an infinite loop in __del__, and its next abort/reconstruction hits the CPU
  limit (3009 ms observed). A call into the old witness facet reports the sticky
  Python-runtime-invalidated error. A fresh loaded interpreter reconstructs that
  witness from its acknowledged SQL state with a new instance UUID.
- A console entry marker was not surfaced through this Dynamic Worker logging
  path. An exploratory SQL marker inside the interrupted finalizer also was not
  retained; it was an unacknowledged write, so it cannot establish durability or
  finalizer entry. Preserved that observation as finalizer-unacknowledged-marker
  evidence, and used the normal/armed finalizer control for the final probe.
- Final focused test passes. Added it to the default suite; prior 35-record
  regression evidence remains the baseline because no runtime code changed.
  Retained finalizer-limit-passing.json and finalizer-limit-test.txt. Diff checks
  pass. This is local Dynamic Worker/facet/limit qualification, not workerd facet
  parity, top-level CPU-policy support, or broad finalizer safety. Goal active.

## Released SDK ASGI adapter and module-level context (2026-09-21)

- Previous turn was verified progress (7eabbf0): bounded finalizer/Dynamic Worker
  facet test. Rechecked the original plan and SDK audit; ASGI/framework support
  and broader bindings/events/distribution remain explicit unfinished scope.
- Added bare ASGI fixture through the unmodified SDK entrypoint(app) adapter.
  Its response path failed on celld with import of workers.wait_until while the
  reference served successfully. Retained native-asgi-failure.json.
- The bridge now supplies cloudflareWorkersModule from the actual host module.
  Its waitUntil copies borrowed Python awaitables immediately and destroys owned
  proxies after settlement, sharing the retention helper with ctx.waitUntil.
  Arbitrary doAnImport, sockets and patch_env remain unsupported.
- Focused comparison passes four concurrent requests, request bodies, Unicode
  path/query, status/header/body equality, lifespan state and per-request shutdown
  KV markers. The marker requires module-level env and background wait_until to
  complete after the response. Both engines use the same source and SDK wheel;
  reference remains workerd 1.20260922.1 under the historical 2025-06-01 envelope.
- This exercises the two-chunk streaming code path but is not causal streaming,
  backpressure/cancellation or ASGI WebSocket proof. No framework dependency is
  claimed yet. Corrected stale SDK audit statements about native .py export/build
  support while preserving the original plan and its remaining requirements.
- Rebuilt fixtures; all 37 full-suite records pass, including ASGI shutdown
  markers, finalizer CPU containment, shared-interpreter cleanup, pressure and
  socket lifecycle. Retained date-prefixed native-asgi failure/passing JSON and
  full-suite log. No new Rust changes. Diff checks pass. Goal remains active.
