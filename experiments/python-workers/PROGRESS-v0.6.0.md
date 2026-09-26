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

## 4. Slice plan (in progress)

A host adapter (`python-host.js`) sits between Pyodide and the host code.
The host code can be a celld or workerd Worker, a Durable Object, or Node. The
adapter owns initialization, bundled package installation, per-session
namespaces, structured results, cooperative interrupts, and detection of
destructive termination. The later sections record the implementation and
test results.
