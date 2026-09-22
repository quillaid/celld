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
  The lexical async compile adapter recognizes the exact sentinel bytes and
  emitted wheel-library bytes and rejects other inputs. Both sentinel and interpreter use native async
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
changed source, and rejection of unlocked dependency manifests and `no_bundle`.

This is an initial native path. Dependency manifests require a matching package
lock as described below. Native Workflow configuration,
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

`npm run test:native-rpc` compares Python Durable Object method calls against
the same pinned workerd envelope and SDK wheel. It covers synchronous/async and
inherited methods, leading underscores, static/class methods, constructor-installed
functions, nested values, exceptions, concurrent requests, distinct objects, and
SQL persistence after a celld process crash. The generated host class extends
`DurableObject` and installs discovered methods inside its initialization gate.
Discovery avoids evaluating Python properties. This is a bounded method bridge:
late-added methods, arbitrary callable descriptors, dunder/host-reserved names,
RPC properties, returned capabilities, cross-node RPC and proxy reclamation
remain unqualified. Python underscores are not an access-control boundary.

`npm run test:websocket` compares native Python Durable Object WebSocket
upgrades, Unicode text, incoming/outgoing binary frames, async message handling,
serialized attachments, clean-close code/reason/status, and abrupt EOF disconnects
with pinned workerd.
SQL records acknowledged through socket replies survive a celld process crash.
The fixture uses `acceptWebSocket`; it does not yet prove eviction with a live
connection, attachment restoration after hibernation, protocol-error callback
parity, outbound sockets or cross-node forwarding. An EOF without a close frame
invokes the close handler with code 1006; it is distinct from a protocol error.
The host transport unit test preserves that distinction for malformed frames.

`npm run test:socket-eviction` separately tests forced local eviction with two
live connections. It requires new Python instance identities, constructor-time
restoration of both sockets, separate attachments, retained tags and continuous
SQL counts across three evictions. After one socket closes, another eviction
must restore only the survivor. Between evictions and application messages, both
sockets receive automatic pong replies while the resident-instance census stays
empty for that object. Application messages then restore residency; auto-response
timestamps survive and fall within the observed ping/reply interval. This does
not qualify memory-pressure eviction or ownership migration.

`npm run test:socket-lifecycle` also runs those checks with `CELLD_IDLE_EVICT_S=1`.
This variant never calls the eviction endpoint: it waits for the residency census
to become empty while continuing matching ping/pong traffic. Automatic idle
eviction, reconstruction, attachment/timestamp preservation, SQL continuity and
closed-socket removal all pass. The one-second policy is a test configuration;
celld leaves idle eviction disabled unless explicitly configured.

`npm run test:native-pressure` uses a 512 MiB active-memory threshold and a
retained 256 MiB Python allocation. It observes memory shedding, object eviction,
empty-interpreter heap release, pressure clearing, and a new Python instance
reading the acknowledged SQL write. The original immediate recovery request
timed out while waiting for the 30-second pool reaper. Runtime shutdown now
attempts guarded empty-pool reclamation as soon as object residency is dropped;
the test requires the immediate recovery request to finish within ten seconds.
Contended or still-active pools retain the periodic fallback. `shared-heap.test.mjs`
verifies that stopping one of two objects preserves their shared interpreter and
the surviving Python instance; stopping the last object frees the heap. Linux
cgroup accounting, pressure across multiple occupied objects, pressure with live
sockets, repeated pressure cycles and extension memory remain unqualified.

`npm run test:proxy-lifecycle` keeps one Python object resident while creating
and evicting another eight times in the same heap. A Python weak-reference census
must return to one live object, and each evicted instance must finalize exactly
once. Host teardown marks released state without calling Python; the adapter
destroys its owned handler proxy on the next admitted Python event. This keeps
Python finalization under event execution limits and avoids interpreter entry
during post-termination host cleanup. Without another event, cleanup is deferred
until one arrives or the whole heap is freed. Returned RPC capabilities, retained
tracebacks and long-run proxy/memory bounds remain separate qualification work.

`npm run test:finalizer-limit` loads the generated SDK bundle as a Dynamic Worker
and mounts its Python Durable Object class as facets of a native parent. A normal
finalizer control completes once; arming that same finalizer's infinite-loop
branch then reaches the configured 3000 ms CPU limit. Later calls to the old
interpreter must report invalidation. A newly loaded interpreter restores the
witness facet's previously acknowledged SQL write. This verifies the configured
Dynamic Worker limit, not a top-level per-request CPU configuration or workerd
facet parity. An exploratory write made inside the interrupted finalizer was
not retained; it was not acknowledged and is not used as a durability guarantee.
Lifecycle event arguments bypass SDK RPC conversion to preserve their FFI types.
The pair contract test also checks `Object.values(new WebSocketPair())` has two
entries: celld previously included an enumerable `length` property.
See [Cloudflare's hibernation example](https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/)
for the API contract; the actual comparison here retains the historical Python
compatibility envelope and explicit `on_` event aliases.

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
observation is retained separately. Compression, cancellation, and large-stream
resource bounds are not qualified by this case.

Upload coverage uses both engines' HTTP listeners: Python returns an SDK
Response backed by request.body, and the client must receive the first bytes
before sending the remaining upload bytes and closing its request. A separate
small Content-Length request covers buffered bodies. Celld's internal body
streams now expose the standard ReadableStream constructor, which the unchanged
SDK checks when accepting a response body. Internal read and tee implementations
are preserved. Both upload cases pass against the historical reference envelope
described above; sustained upload resource limits remain open.

Response cancellation coverage reads the first bytes, aborts the actual HTTP
client, then releases the Python producer's gate. Its subsequent TransformStream
writes must reject before completing the bounded payload, and its finally block
must release the writer and report completion through a separate HTTP request.
Both engines then serve an ordinary follow-up request. Exact error text and the
number of writes accepted before disconnect propagation differ; this check
asserts the shared cancellation behavior. It does not measure proxy reclamation,
RSS, or cancellation without waitUntil keeping work alive.

Upload cancellation uses an unfinished chunked HTTP request. Python confirms it
read the six-byte prefix through a separate callback before the test destroys
the client's connection. The waitUntil-retained reader must reject from read()
with exactly those six bytes observed, release its lock, and report from finally.
Both engines pass and serve a follow-up request. This tests abrupt socket closure;
graceful EOF and application-driven cancellation are separate contracts.

### Locked Python packages

`node lock-packages.mjs /absolute/path/to/project` resolves one `pyproject.toml`
(`[project].dependencies`) or `requirements.txt` (one PEP 508 requirement per
line). This runs micropip 0.10.1 inside the pinned Pyodide 0.28.3 interpreter, so
markers describe CPython 3.13.2 on Emscripten rather than the build machine.
Dynamic dependencies, pip command-line options and continuations are rejected.
The tool independently checks installed versions against root and transitive
requirements, extras, markers and Requires-Python before writing the lock. This
rejects conflicting roots that the pinned micropip accepted in testing. Micropip
is not a general backtracking solver; a resolution failure may require choosing
compatible explicit versions even when a different dependency solution exists.

The command writes `celld-python.lock.json` with the input manifest hash, target
ABI, resolver identity, selected package closure, versions, HTTPS wheel URLs
and SHA-256 hashes. Verified wheel bytes go into `.celld/python-wheels/` under
their hashes. A successful resolution atomically replaces the lock; a failure
preserves the previous lock. Resolution may contact the pinned Pyodide CDN and
PyPI. The consumer accepts pure Python wheels and exactly
`cp313-cp313-pyodide_2025_0_wasm32` wheels; build-machine platform wheels are
unsupported. Native-extension qualification is described below.

`npm run test:packages` checks a PyPI wheel (`humanize`), a runtime-index wheel
(`python-dateutil`) and its transitive dependency (`six`). It verifies repeatable
locks, target markers, corrupt-cache/conflict rejection and imports directly from
the locked wheel bytes with networking disabled. This is currently a separate
package-tool test, not part of the celld HTTP suite.

Native dev/deploy now consumes this lock from the project root, including when
the Python entry lives in a subdirectory. The builder rejects missing/stale
locks, mismatched ABIs, missing dependencies and corrupt cached wheel bytes. A
missing cached wheel can be fetched from its locked HTTPS origin at build time;
request startup uses only bundled bytes. Wheels are checked for supported pure
layouts, path traversal, symlinks, file collisions and SDK conflicts before
unpacking. Relocated .data layouts and .pth startup hooks are explicitly rejected.

Packages are mounted for build-time import checks and runtime SDK dispatch. The
lock and its digest participate in deployment identity; wheel bundle module
names use their content hashes, never local cache paths. Native HTTP and a
generated-bundle startup with global fetch disabled both exercise humanize,
python-dateutil and six. Tests verify identity survives directory relocation and
changes when a package version changes. Run `npm run test:native-packages`; this
case is also in the default HTTP suite.

`npm run test:package-lifecycle` checks watched dependency updates and the pinned
workerd reference. A changed requirements file with a stale lock keeps serving
the last good Worker. A wrong-ABI lock also fails without replacing it; publishing
the matching lock loads the requested version, and restoring the original pair
restores the original package. The reference case runs identical Python with
the same locked wheel bytes and verifies the loaded SDK digest, package versions,
number formatting and date parsing under the historical compatibility envelope.
The reference exposes the pure wheels on Python's zip import path; celld unpacks
its bundled copies. No Cloudflare package resolution parity is inferred.

Cache hits verify without rewriting files. Missing wheels are verified and
published by atomic rename, so concurrent readers cannot see partial cache
contents. Corrupt cached artifacts remain errors.

Package startup hooks, broader wheel layouts and framework behavior remain
unqualified. The builder is still a local experimental helper, not a published
distribution.

### Compiled extension checkpoint

The native builder verifies target wheel tags and Wasm magic, extracts `.so`
modules, and emits content-addressed Wasm imports alongside the interpreter.
Their names and digests are checked again by celld before packaging. The lexical
async Wasm compiler matches exact library bytes to those immutable modules.
After unpacking, the SDK adapter preloads their paths through Pyodide's pinned
private `_api.loadDynlib` hook, then imports the application. This internal hook
is part of the pinned 0.28.3 integration and needs review on runtime upgrades.

`npm run test:native-extension` calls MarkupSafe 3.0.2's `_speedups._escape_inner`
through real HTTP. The test requires the `.so` module path and builtin-function
identity, so the package's pure-Python fallback cannot satisfy it. The generated
bundle also starts and executes the extension with global fetch disabled.

The same test compares identical SDK Python and wheel bytes with workerd
1.20260922.1 under the historical 2025-06-01 compatibility envelope. Wheel files,
including the .so, are mounted as read-only Worker Data modules. The older
PythonRequirement module type is rejected by that workerd build. Source
inspection of [workerd at c22e7ae](https://github.com/cloudflare/workerd/blob/c22e7ae3b5e2fc5fc1cf382eee0110550497668d/src/pyodide/internal/python.ts)
identified its read-only-filesystem compilation path; the executable comparison
is the evidence that this mounting format works with the pinned binary.

The engines report matching extension and SDK digests, builtin-function identity
and results for ASCII, BMP Unicode and astral Unicode inputs. Only their module
filesystem paths are normalized. This qualifies one C-extension wheel; it does
not establish current-date compatibility, matching package resolution, or the
same startup/snapshot implementation. Multi-library graphs, shared-library
archives, NumPy-style workloads, extension reload and resource pressure remain
unqualified.
