# Python Workers feasibility spike

This runs Pyodide 0.28.3 (CPython 3.13.2, Emscripten ABI `2025_0`) inside celld.
HTTP, KV, and outbound fetch work on unmodified 0.5.1. The full lifecycle suite
requires this branch's host invalidation patch. It is **not** native `.py`
deployment support or the Cloudflare Python SDK.

## Reproduce

From this directory:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
CELLD_BIN=/absolute/path/to/celld-0.5.1 npm run test:smoke
```

Without `CELLD_BIN`, the test uses `../../.celld/tools/celld`. The first run's
task-local Apple Silicon release binary came from
https://github.com/denoland/celld/releases/download/v0.5.1/celld-aarch64-apple-darwin.gz
and its decompressed SHA-256 is
`88ab836fc6aa75c23c446abe2e207bb09f25c8bf47e661b3c1bcbb2b2e858da4`.
Use the appropriate official release artifact on another platform.

Tests start their own celld process group and local outbound HTTP endpoint,
allocate isolated local storage, and stop those processes afterward. Runtime
assets are bundled; startup does not fetch Pyodide or the stdlib from a CDN.
The explicitly requested outbound fetch in the test goes only to loopback.
Dependencies are pinned by `package-lock.json`.

The smoke suite also runs the same Python source against workerd
`1.20260922.1`, using Miniflare `5.20260921.0-alpha` for real local KV bindings.
This reference may download its Cloudflare Pyodide bundle at startup. It uses
Cloudflare's Pyodide 0.28.2 / CPython 3.13.2 and compatibility date 2025-06-01;
the celld fixture uses upstream Pyodide 0.28.3 / CPython 3.13.2. The reference
adapter uses that historical SDK's `on_fetch`. HTTP JSON values compare exactly;
error checks compare status and Python type/message, retaining both raw stacks.
This establishes those operations, not current SDK parity.

`npm run test:wasm` probes native Wasm APIs separately. Precompiled-module
instantiation passes on both engines. Raw byte compilation currently times out
on celld and is rejected by workerd. Set `WASM_REQUIRE_BYTE_COMPILATION=1` to
make the celld timeout a failing regression check.

`npm run test:resources` reproduces a lifecycle failure on unmodified 0.5.1:
CPU termination leaves asyncio's current-task table populated, and the next
async invocation hangs. Retained failing evidence includes a fixture-only
`/__diagnostics` route showing that synchronous Python evaluation still works.
Clearing that table would not establish that native interpreter state is safe.

The branch's `python_workers` flag now makes hard termination invalidate the
isolate at the host boundary. New calls and continuations are explicitly
rejected; they cannot re-enter Python. Tests prove rejection of two new calls
and an already-suspended Python task, then successful explicit replacement.
All 12 current test records pass on the patched source build. Automatic pool
replacement and prompt cancellation of hung I/O still need implementation and
tests; Python Durable Object recovery is not yet qualified.

To run this full suite, build at the repository root with:

```sh
RUSTY_V8_MIRROR=https://github.com/denoland/rusty_v8/releases/download cargo +1.94.1 build -p celld
```

Then from this directory run `CELLD_BIN="$PWD/../../target/debug/celld" npm test`.
The flag is an experimental lifecycle opt-in, not an SDK/deployment parity claim.
A separate test passes 100 allocate/release cycles of 16 MiB with stable Wasm
linear memory after initial growth. This does not establish process-RSS bounds
or freedom from leaks. Both failing and passing evidence remain in `evidence/`.

`results/smoke.json` records timing samples and node RSS before/after requests.
RSS includes the whole node and KV work, so its difference is not a clean
per-interpreter allocation measurement. Cold timing starts after celld announces
readiness, excluding process startup and compiled-Wasm registration. This is a
smoke measurement, not a comparative performance benchmark.

## Adapter boundaries

- `worker.py` uses Pyodide's `js` FFI and a fixture-specific handler. It does not
  yet implement `from workers import WorkerEntrypoint`.
- `runtime-assets.js` gives the generated bundle lexical worker-environment
  shims. Host `process`, `self`, `fetch`, and `WebAssembly` are not replaced.
- Pyodide's Emscripten factory registers its ordinary `_createPyodideModule`
  global inside the isolate. This needs cleanup/design review for production.
- The interpreter is a celld compiled-Wasm import; its mutable memory belongs
  to an instance. The stdlib zip is embedded in JS for this fixture only.
- The build extracts Pyodide's pinned sentinel Wasm from the dependency and
  verifies its exports, then packages it as another compiled-module import.
  The lexical compile adapter recognizes only those exact sentinel bytes and
  rejects unbundled modules. Both sentinel and interpreter use native async
  instantiation of compiled modules. The separate raw-byte compile stall remains
  a celld issue; it is no longer required by this fixture's startup path.
- Initialization is lazy and cached per adapter instance, including failure.
- The callable PyProxy stays alive with the runtime. Returned Python futures
  are destroyed after settlement. Leak resistance still needs a long-run test.
- Detailed initialization errors are returned by this diagnostic fixture.
  That is not the proposed production error-response policy.

## Known failure and fix

The initial bundle selected Emscripten's shell environment. Its entropy path
then attempted `os.system`, leaving CPython initialization incomplete and
causing a later `memory access out of bounds` error. The identical generated
bundle reproduced under Node. Lexically selecting the worker environment uses
`crypto.getRandomValues` and lets the original HTTP repro pass.

## Remaining gates

Current Workers SDK entrypoint; safe post-termination behavior; cancellation;
memory pressure and process-level bounds; proxy leak testing;
runtime/package security and reproducibility review; native packaging/dev UX;
Python Durable Object lifecycle and persistence. No production compatibility
claim follows from this spike.

Pyodide is MPL-2.0. Dependencies and generated artifacts remain external or
ignored; this directory contains the original adapter, build scripts, and
fixtures. Preserve the upstream source/license obligations when designing
runtime redistribution.
