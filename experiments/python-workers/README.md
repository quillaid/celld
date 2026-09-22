# Python Workers feasibility spike

This runs Pyodide 0.28.3 (CPython 3.13.2, Emscripten ABI `2025_0`) inside celld.
HTTP, KV, and outbound fetch work on unmodified 0.5.1. The full lifecycle suite
requires this branch's host invalidation patch. It is **not** native `.py`
deployment support. A separate fixture loads the unmodified Cloudflare Python SDK.

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
The host wakes suspended invocations on invalidation; a Python request sleeping
for 60 seconds is rejected around the CPU cutoff, rather than waiting for its
timer. Invalidated pool slots retire through the existing reference counters.
A separate test caps the stateless pool at one active isolate and verifies five
distinct Python interpreters across repeated hard terminations. That fixture
uses Python FFI to the host's global `process.exit` method; the Dynamic Worker
test exercises CPU limits.

`npm run test:durable` exercises two actual Python objects sharing an interpreter,
independent SQL counters, abort/recreation, and an interrupted Python
`blockConcurrencyWhile` callback. The original same-heap recovery and held-gate
failures are retained. The host now reports unusable heaps to the decision core,
which reuses celld's bounded runtime-swap path at the same ownership epoch.
Host input-gate claims retire without invoking guest cleanup. Both counters'
acknowledged values remain readable after recovery. These local tests do not
qualify remote durability or transport cancellation.

`npm run test:persistence` verifies Python SQL rollback, ten concurrent increments,
alarm delivery, and recovery of eleven acknowledged increments plus a pending
alarm after killing the test supervisor and its separately supervised node.
Restart uses exactly the same persistent local development store. Both Python
instance and interpreter identities change. This does not qualify remote object
storage, multi-node ownership transfer, or alarm retry behavior.

`npm run test:transactions` compares zero-argument callbacks and nested rollback
against pinned workerd and checks existing Workflow event consumption. Python's
strict callback arity exposed the host's extra callback argument; the host now
also creates savepoints for nested calls through the public root storage object.

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

## Released SDK fixture

`npm run build` also verifies/downloads the pinned workers-runtime-sdk 1.9.0
wheel and builds `dist/sdk.js`. Cached SDK bytes are hash checked; requests use
only bundled assets. `npm run test:sdk` runs the same source through celld and
pinned workerd, verifying loaded SDK identity, HTTP JSON/status/headers, binary
bodies, and background KV work. See [SDK_AUDIT.md](SDK_AUDIT.md) for the host
hooks, historical reference envelope, and remaining gaps. This fixture uses real
SDK classes but does not provide native Python deployment.

## Adapter boundaries

- `worker.py` uses Pyodide's `js` FFI and a fixture-specific handler. It does not
  yet implement `from workers import WorkerEntrypoint`.
- `durable.py` and the exported JS `PythonCounter` provide a fixture-only class
  bridge onto the host's existing context and SQL. This is not the Workers SDK.
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
the remaining Python Durable Object lifecycle and persistence cases. No production compatibility
claim follows from this spike.

Pyodide is MPL-2.0. Dependencies and generated artifacts remain external or
ignored; this directory contains the original adapter, build scripts, and
fixtures. Preserve the upstream source/license obligations when designing
runtime redistribution.

Deployments built with `python_workers` now require `python-lifecycle-v1` in
addition to any Wasm capability. This identifies the host termination/retirement
contract, not SDK parity. Nodes whose feature list predates that contract reject
the manifest through the existing required-feature gate.

## Experimental native Python projects

The branch's `celld dev` and `celld deploy --dry-run` now recognize a `.py` main
entry and invoke a build-time helper. Prepare this directory with `npm ci` and
`npm run build`, then point the branch binary at the helper:

```sh
export CELLD_PYTHON_BUILD="/absolute/path/to/celld/experiments/python-workers/build-project.mjs"
/absolute/path/to/celld/target/debug/celld dev /path/to/python-project
```

The project can contain `worker.py`, local Python modules/packages below the
entry's directory, and this `wrangler.json`:

```json
{
  "name": "python-example",
  "main": "worker.py",
  "compatibility_flags": ["python_workers"]
}
```

```python
from workers import WorkerEntrypoint, Response

class Default(WorkerEntrypoint):
    async def fetch(self, request):
        return Response("Hello from Python")
```

The helper is currently repository-local, not a published package. It bundles
pinned Pyodide and the released SDK, checks runtime/SDK hashes, records source
hashes, and emits runtime metadata that participates in deployment identity.
Celld validates the builder descriptor and Wasm digests before accepting the
output. Build-time SDK download is permitted when the verified cache is absent;
request-time runtime downloads are not used.

`npm run test:native` verifies real dev HTTP with a local module, matching
versions for identical projects in different directories, a changed version for
changed source, and rejection of dependency manifests and `no_bundle`.

This is an initial native path. Python dependency manifests are rejected pending
the resolver, even if they declare no dependencies. Native Workflow configuration,
`define`, `rules`, and `no_bundle` are rejected. Additional event/RPC exports,
complete import checks, source/data selection,
package startup hooks, release distribution, and the full compatibility matrix
still need implementation or qualification. Native Durable Object fetch/alarm
exports now have a separate SDK comparison.

`npm run test:reload` checks native Python watched reloads: a local-module edit
is adopted, a syntax error leaves the last good deployment serving, and a valid
edit afterward recovers. The builder compiles every collected source with pinned
CPython before emitting a bundle, without executing application top-level code.
It reports Python diagnostics directly. This does not validate missing imports
or promise uninterrupted service during celld dev's existing node restart.

Native builds also check unconditional top-level module imports against bundled
local modules and the SDK, without executing parent packages. Missing local
modules/submodules fail with source filename and line. Namespace packages are
supported. Imports inside conditions/functions/try blocks, imported attributes,
and detailed standard-library availability remain runtime checks; this is not a
complete static dependency resolver. Optional imports are not rejected merely
because the optional module is absent.

`npm run test:native-durable` builds a normal Python project with SDK
`DurableObject` classes and generates its configured exports. The default Worker
and Durable Objects share initialization within each deployment isolate; each
Durable Object retains its own Python instance. The test compares SQL updates,
rollback, SDK abort recovery, and alarms against pinned workerd using the same
Python source and wheel. Celld additionally undergoes a local process-crash
restart and retains SQL/alarm state. The reference uses historical on_fetch and
on_alarm dispatch aliases. This does not qualify remote durability, RPC,
WebSocket callbacks, or long-run proxy reclamation.

The default suite runs two test files at a time to bound simultaneous runtime
startups. Individual concurrency probes and deadlines are unchanged. Earlier
unbounded-file runs sometimes timed out waiting for the workerd SDK reference
first response; phase evidence distinguishes this from celld response time.

The SDK comparison now includes an identity-encoded streaming response. Python
writes a first chunk, awaits a test-controlled loopback HTTP request, then writes
a second chunk. Each client must receive the first bytes while that HTTP request
is still held, and both engines must return the same completed body. This proves
incremental delivery rather than merely comparing a buffered result. The test
allows network chunk splitting and keeps read demand active while holding the
producer gate. Workerd's default gzip response buffered this tiny prefix; that
observation is retained separately. Compression, upload streaming, cancellation,
and large-stream resource bounds are not qualified by this case.
