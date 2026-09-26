# Python host on celld v0.6.0: progress and evidence

Branch `quod/python-workers-v0.6.0`, based on v0.6.0 (`bad4649`). The
historical research branch `quod/python-workers` (`6ab0d99`, based on v0.5.1)
is preserved unchanged. Its results are context, not evidence for v0.6.0. Every
claim below is labeled.

Labels: **Confirmed** = reproduced in this branch on lab3 (Linux x86_64, Node
22.23.3). **Source** = read in the cited code, not executed. **Historical** =
reported on the old branch, not rerun here. **Hypothesis** = untested.

## 1. What v0.6.0 changes for Python

- **Source:** `transactionSync()` now passes no callback argument and nests
  through savepoints (`crates/celld/js/harness.js:1751`, documented in
  `docs/services/durable-objects.md`). The historical branch fixed the same
  Python arity bug (`e420489`). **Confirmed:** `transaction-contract.test.mjs`
  passes on the stock v0.6.0 release binary. Do not port that fix.
- **Source:** Dynamic Worker Wasm modules must use `{ wasm: bytes }`, and
  `compatibilityDate` is required. The historical `resource-driver.js` already
  uses that form.
- **Source:** every main-module export must be a handler object or a class.
  Generated Python entry shims must not export other values.
- **Source:** WebSocket frames pass the output gate one at a time, and facets
  now use their own SQLite streams. Neither changes the interpreter layer.
- **Source and confirmed:** these are still absent in v0.6.0:
  - `queueMicrotask` passes one argument to its callback, where workerd passes
    none (`harness.js:10736`). **Confirmed:** the contract test fails with
    `argumentsSeen: 1`.
  - `WebSocketPair` has an enumerable `length` (`harness.js:10676`).
    **Confirmed:** the contract test fails.
  - Body streams report `constructor.name` `CelldHttpBodyStream`. **Source**
    only; the historical SDK upload failure is not rerun.
  - Unclean WebSocket EOF still calls `webSocketError` (`harness.js:5778`).
  - There is no host invalidation after hard termination.
    `take_execution_termination_in_context` cancels termination, and the
    isolate stays in use (`crates/celld/js.rs:2854`).
- **Source:** `ctx.abort()` on a directly dispatched Durable Object event calls
  `op_actor_abort` → `terminate_execution` (`js.rs:9511`). If Python calls it,
  the call terminates the interpreter while Python code runs.

## 2. Linux baseline on v0.6.0

The official release binary is `celld-x86_64-unknown-linux-gnu`, with SHA-256
`508568643a7d374f302a26d96a67cea2af1a621e3a7d7d5990a09cd51d135fcf`. A
debug build from the tag (Rust 1.94.1) takes 2m08s. The fixtures are ported
unchanged from `6ab0d99` (commit `353480e`). Evidence files are in `evidence/`
and are named `2026-09-26-v060-release-*`.

| Probe (stock v0.6.0 release) | Result |
| --- | --- |
| `smoke`: 4 concurrent cold starts, KV, outbound fetch, traceback and recovery, 20 warm requests, same-source workerd 1.20260922.1 comparison | **Confirmed pass** (7/7). Cold batch 1.62 s, warm ~2 ms |
| `transaction-contract` | **Confirmed pass** |
| `async-wasm`: precompiled module instantiation | **Confirmed pass**. Raw-byte `WebAssembly.compile` still **hangs** in celld, and workerd rejects it |
| `microtask-contract`, `websocket-pair-contract` | **Confirmed fail** (host gaps listed above) |
| `resources`: memory plateau, CPU limit | **Confirmed pass** |
| `resources`: after a 25 ms CPU kill | **Confirmed fail**. A suspended Python request never wakes, and the next call does not finish in 15 s |
| `durable`: after `ctx.abort()` from Python | **Confirmed fail**. The next request to that object times out after 8 s |
| `pool-lifecycle`: after a Python-triggered `process.exit` | **Confirmed fail**. The next warm request times out after 7 s |

Conclusion (**confirmed**): v0.6.0 runs Pyodide 0.28.3 for ordinary
execution. Destructive termination still leaves an interpreter that cannot
be used, and it gives no error. It hangs.

## 3. Interruption: primary sources

- **Source:** in CPython 3.13.2, `Python/emscripten_signal.c` reads
  `Module.Py_EmscriptenSignalBuffer[0]` through an EM_JS helper every 50
  eval-breaker ticks, and only while `Py_EMSCRIPTEN_SIGNAL_HANDLING` is 1. The
  mechanism belongs to upstream CPython's Emscripten port, not only to Pyodide.
- **Source:** in Pyodide 0.28.3, `setInterruptBuffer(TypedArray)` sets that flag
  and that buffer (`src/js/api.ts:630`). Any TypedArray works. The
  SharedArrayBuffer is only needed when another thread writes the buffer. The
  docs assume a browser Web Worker with cross-origin isolation.
- **Source:** in workerd `1481f44` (2026-09-25), `src/pyodide/internal/python.ts`
  uses a non-shared `Uint8Array(1)` that holds SIGXCPU. A C++ CPU-limiter
  callback that does not hold the isolate lock writes
  `_Py_emscripten_signal_clock=0` and `Py_EMSCRIPTEN_SIGNAL_HANDLING=1` into
  Wasm memory. Python then raises `CpuLimitExceeded` (`introspection.py`).
  `clearSignals` runs before each Python call and timer callback. For 0.28.2,
  the clock address is a hard-coded offset because the symbol is not exported.
  No caller of `getCpuLimitNearlyExceededCallback` is in open-source
  `src/workerd/io` or `src/workerd/server`. **Hypothesis:** only Cloudflare's
  production limit enforcer calls it, so local workerd cannot exercise it. No
  user-triggered KeyboardInterrupt API exists.

**Confirmed mechanism probe** (`probes/interrupt-mechanism.mjs`, Node 22 with
the pinned Pyodide; evidence `2026-09-26-node-interrupt-mechanism.json`):

1. `_Py_EMSCRIPTEN_SIGNAL_HANDLING` is exported. `_Py_emscripten_signal_clock`
   is not. `_emscripten_stack_get_current` is exported and has the same value
   whenever no Python code runs.
2. A signal written while Python is suspended raises KeyboardInterrupt inside
   `webloop.py run_handle` (the event loop's timer callback), not inside the
   user's code. The awaiting code **never settles**, and Pyodide logs "Task was
   destroyed but it is pending". Therefore the adapter must never write the
   raw buffer while Python is suspended.
3. `task.cancel()` stops a long `await`.
4. A cross-thread SharedArrayBuffer write interrupts a synchronous `while True`
   with KeyboardInterrupt, and the namespace survives.
5. Enabled signal checks cost 236 ms against 232 ms on a 3M-iteration loop
   (one sample).
6. A second `loadPyodide()` works in the same JS realm.

## 4. The host adapter slice

`python-host.js` (JS) and `python_host.py` (Python) form one interface
between an embedding host and the pinned interpreter. The host supplies
`loadRuntime()`, which returns a Pyodide instance from bundled assets. The
adapter never downloads anything.

| Operation | Contract |
| --- | --- |
| `ready()` | Starts one shared initialization, which concurrent callers share. A corrupt package fails the initialization before any Python code runs. |
| `execute(session, code)` | Supports top-level await. Returns `{status: ok\|error\|interrupted\|invalidated, value (repr), stdout, stderr, error {type, message, traceback}, count, execution, generation}`. A Python error is a result, not a host failure. Tracebacks omit adapter frames. |
| `bind(session, name, value)` | Exposes a host object to the session explicitly, for example a Durable Object's `ctx` or `env`. A new interpreter receives the bindings again. |
| `interrupt(session)` | Cancels the session's suspended executions and reports KeyboardInterrupt. The namespace and the interpreter survive. |
| `signals` / `onRunning` | Only for hosts that have a cross-thread writer: a real KeyboardInterrupt in synchronous code. The SIGINT handler routes each signal to its target execution, and an untargeted signal is cancelled at the next await. |
| `session()` / `dispose()` | Inspect or free one namespace. |
| `capabilities()` | Reports only what this host provides: `interrupt.running` is `signal-buffer` or `unavailable-without-cross-thread-writer`, plus host JSPI and interpreter stack switching. |
| destructive termination | Detected through an entry marker. The adapter fails pending executions as `invalidated`, starts a new interpreter (generation + 1), and reports that every namespace was lost. |

Packages: `lock-packages.mjs` (ported) resolves a lock in the target
interpreter. `build.mjs` now bundles a lock for fixture entries through
`celld-python-packages`, and the adapter checks each artifact's SHA-256 before
it unpacks it. The fixture lock is humanize 4.12.3 (pure) and MarkupSafe 3.0.2
(cp313 pyodide_2025_0). The compiled `.so` loads through a precompiled Wasm
module, because raw-byte compilation still hangs in celld.

**Confirmed, Node** (`python-host.node.test.mjs`, 13/13; evidence
`2026-09-26-node-python-host.txt`): concurrent callers share one
initialization; values, output, counters, separate namespaces, structured
errors and syntax errors behave as specified; both packages load, and the
compiled module is the `.so`; a suspended execution is interrupted while a
neighbor session keeps running; `finally` runs; bindings and dispose work; a
corrupt wheel is rejected. **The raw-signal failure from section 3 no longer
happens**: a signal written while Python is suspended is routed, nothing
escapes to the event loop, and the loop keeps working. A real Node worker
thread interrupts `while True` through a SharedArrayBuffer that targets one
execution id, and the namespace survives.

## 5. celld Durable Object results

`session-worker.js` gives each Durable Object instance one session. Every
object in the isolate shares one interpreter. `session.test.mjs` (12 records)
passes on **both** the stock v0.6.0 release binary and the patched debug
build. Evidence: `2026-09-26-v060-{release,patched}-session.{txt,json}`.

**Confirmed on stock v0.6.0:**

- Two concurrent first requests to different objects start one interpreter in
  one isolate.
- Namespaces are per object and persist across requests. Output capture,
  structured errors, and locked pure and compiled packages work, as does a
  stateless Worker session.
- Durable vs ephemeral: SQL written through the bound `ctx` survives forced
  eviction, and the namespace does not. **Finding:** eviction left the
  interpreter and the old namespace alive in the same isolate. Without
  explicit disposal, a new object instance could have seen the Python state of
  its predecessor, depending on isolate placement. The fixture ties the
  namespace to the object instance and disposes the old one.
- Interrupting a suspended execution returns KeyboardInterrupt within about
  10 ms of the interrupt request. `finally` runs, and the namespace stays
  usable.
- `ctx.abort()` called from Python terminates execution. **Confirmed:**
  neither JS `catch` nor `finally` runs under that termination
  (`probes/termination-skips-finally.mjs`, evidence
  `2026-09-26-v060-release-termination-skips-finally.txt`). The entry
  marker is 1 afterwards. A suspended execution in a *sibling* object settles
  as `invalidated` within one 100 ms poll. The next call starts generation 2
  in 1.35 s, packages still load, and the sibling's old variable reports
  NameError. On the historical fixture, the same situation hung.
- **JSPI finding.** celld v0.6.0 exposes `WebAssembly.Suspending`, and Pyodide
  0.28.3 then uses stack switching. Each awaited async Python entry leaks
  48 bytes of the 5 MiB Emscripten stack: 96,128 bytes after 2,000 calls,
  and 4.8 MB after 100,000. The next request that crosses the limit **hangs
  without an error**, and the pool routes later traffic to a new isolate
  (`2026-09-26-v060-release-jspi-stack-exhaustion.txt`). The same leak
  reproduces in Node 22 with `--experimental-wasm-jspi`. Pyodide 314.0.7 stays
  flat in the same Node test (`2026-09-26-node-jspi-stack-drift.txt`).
  **Mitigation in this slice:** the bundle's lexical `WebAssembly` omits the
  JSPI members, and the depth then stays at 32 bytes across 115k entries in
  celld (`...-jspi-hidden-no-exhaustion.txt`). `pyodide.ffi.run_sync` is
  unavailable as a result. **Hypothesis:** 314.x also fixes the leak under
  celld's newer JSPI API. That is not tested in celld.
- The stack pointer therefore cannot detect termination: it drifts under JSPI.
  The adapter uses the entry marker instead.

**Confirmed on the patched build only** (commit "Interrupt synchronous
Python ..."): a Durable Object spinning in `while True` blocks its isolate. A
normal `/interrupt` request times out, which is expected. `POST
/python/interrupt/<scope>` on the internal listener writes SIGINT from the
node's thread. It targets the execution id that the session published, and
KeyboardInterrupt arrives within 7 ms. The namespace, the partial loop
counter and the interpreter (still generation 1) all survive. An idle scope
returns `idle`, and an unknown scope returns 404. On the stock binary, the
adapter reports `unavailable-without-cross-thread-writer`, and the route
does not exist.

## 6. Interrupt vs termination, by host

| Host | Suspended Python | Synchronous Python | Destructive termination |
| --- | --- | --- | --- |
| celld v0.6.0 stock | task cancel (**confirmed**) | none. The isolate thread is blocked, and top-level Workers and Durable Objects have no CPU limit (**source**) | `ctx.abort()`, a Dynamic Worker `cpuMs` limit, `process.exit`: the interpreter is unusable afterwards (**confirmed**). The adapter detects this and replaces the interpreter (**confirmed** for `ctx.abort()`) |
| celld patched (this branch) | task cancel | node-thread SIGINT via `python_signal.rs` (**confirmed**, local owner only) | same as stock |
| workerd OSS | not reached. **Confirmed:** the upstream Pyodide bundle cannot initialize there (see below) | no user API. The CPU-limit near-exceeded callback raises `CpuLimitExceeded`, and no caller exists in OSS (**source**) | **hypothesis:** the isolate is condemned; not verified |
| Browser Web Worker | task cancel | SharedArrayBuffer from the page, only when cross-origin isolated (**source**: Pyodide docs) | `worker.terminate()` ends the whole worker |
| Node worker thread | task cancel (**confirmed**) | SharedArrayBuffer (**confirmed**) | n/a |

**Confirmed, workerd probe** (`probes/workerd-session.mjs`, workerd
1.20260922.1; evidence `2026-09-26-workerd-session-probe.json`). The
unchanged session bundle, run as an ordinary Worker with a Durable Object:

1. It failed at startup because the fixture called `crypto.randomUUID()` at
   global scope. celld v0.6.0 allows that call, and workerd does not. The
   fixture is now lazy.
2. Interpreter instantiation then fails with `Wasm code generation disallowed
   by embedder`, from a synchronous `new WebAssembly.Module()`, and the
   initialization **never settles**. **Source/hypothesis:** the likely trigger
   is Emscripten's `convertJsFunctionToWasm` (`addFunction`) path, which
   compiles tiny modules at run time when `WebAssembly.Function` is absent.
   Cloudflare runs its own Pyodide build and loader, not upstream Pyodide.
   Therefore **the shareable layer is the adapter contract**
   (`python_host.py`, the result schema, the capability report), with one
   runtime loader per host. A single shared bundle is not the shareable
   layer. The adapter also needs an initialization deadline, because a
   loader that fails inside Emscripten does not reject.

## 7. Deliberately deferred

- Prepared snapshots and the ASGI upload overlay (not required here).
- The historical Rust invalidation, pool retirement and Durable Object recovery
  path (`b344887`..`072df4b`). The adapter's in-realm replacement covers the
  tested `ctx.abort()` case without host changes. Residual risk
  (**hypothesis**): callbacks of the dead interpreter, such as JS promise
  continuations or timers, can still enter its Module. The marker also misses
  a termination inside such a small unmarked entry. Host retirement of the
  isolate remains the robust answer.
- Workers SDK (`WorkerEntrypoint`) dispatch. It should sit on this adapter,
  not beside it.
- workerd execution of this adapter bundle.
- A Pyodide 314.x upgrade (ABI `pyodide_2026`?, new locks). Needed to regain
  JSPI and `run_sync` safely.


## 8. Next decisions for Kyle

1. **Runtime line.** Stay on Pyodide 0.28.3 with JSPI hidden (tested
   here), or move to 314.x (CPython 3.14, new wheel ABI and locks), which
   stays flat under JSPI in Node. Moving to 314.x brings back `run_sync`.
2. **Interrupt route.** The prototype writes signals only for a Durable
   Object owned by the local node, through the unauthenticated internal
   listener. A product route needs an application-facing call that a busy
   isolate does not have to serve. One option is a stub method handled by
   the host before dispatch; another is a binding. Owner forwarding and
   authentication are also needed.
3. **Termination recovery.** Choose between in-realm replacement (this slice:
   no host change, with residual risk from old callbacks) and host retirement
   of the isolate (the historical `b344887`..`072df4b` approach, a larger
   Rust change).
4. **workerd.** Target Cloudflare's Python runtime through the same
   `python_host.py` and result contract, with a workerd-specific loader.
   Upstream Pyodide cannot initialize there.

## Reproduce

```sh
cd experiments/python-workers
npm ci --ignore-scripts --no-audit --no-fund && npm run build
# stock release binary (downloaded to ../../.celld/tools/celld) or this branch's build:
CELLD_BIN=/abs/path/celld npm test          # adapter (Node), celld sessions, microtask contract
                                            # patched: 26/26; stock v0.6.0: the microtask contract fails (known gap)
npm run test:baseline                       # historical smoke + workerd comparison
node --experimental-wasm-jspi probes/jspi-stack-drift.mjs
```

The Rust build uses `RUSTY_V8_MIRROR=https://github.com/denoland/rusty_v8/releases/download
cargo +1.94.1 build -p celld`. The patched binary's SHA-256 is in
`evidence/2026-09-26-v060-patched-build.sha256`. The unit test is
`cargo +1.94.1 test -p celld --lib python_signal`.
