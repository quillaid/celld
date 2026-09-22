# Python Workers on celld: investigation and implementation plan

Research date: 2026-09-21 (America/Los_Angeles).

## Recommendation

Pursue a bounded Pyodide feasibility spike on celld v0.5.1. Run CPython/Wasm inside celld's existing V8 isolates, with a JavaScript adapter connecting Python handlers to the existing Workers APIs. Keep ownership, scheduling, SQLite, output gates, and network I/O under celld's existing host implementation.

This is a proposed architecture, not a working implementation. No Python runtime was downloaded, built, or executed in this investigation. No live fleet was changed.

## Verified baseline

- Fetched upstream `origin/main`: v0.5.1, `42269c121c989c65c0638ab01f368baf18a5f0df`, released September 19.
- The current checkout remains on `quod/nteract-d1-routing-investigation`, HEAD `6082b9c`. Existing untracked patch/output files were preserved. Read current source through Git rather than resetting this checkout.
- Since v0.4.1, releases add Containers/Sandbox SDK support, Dynamic Workers, broader service binding/RPC support, prebuilt Wasm deployment, and memory/recovery improvements. v0.5.1 adds Dynamic Worker resource limits and further deployment/runtime compatibility work.
- The compatibility page still marks Python Workers unavailable.
- Upstream issue #136 is closed. Ryan's response: “Not planned. Conceivably if there was enough demand...” This is not an accepted upstream roadmap item.
- Cloudflare's current Python execution model is CPython compiled to Wasm via Pyodide, inside V8. Its deployment flow additionally prepares memory snapshots.
- Cloudflare packages include pure Python, PyEmscripten wheels, and packages supplied with Pyodide. Ordinary macOS/Linux binary wheels are not the target format.

Release notes: https://github.com/denoland/celld/releases/tag/v0.5.0 and https://github.com/denoland/celld/releases/tag/v0.5.1

Upstream scope: https://github.com/denoland/celld/issues/136

Cloudflare architecture: https://developers.cloudflare.com/workers/languages/python/how-python-workers-work/

Package contract: https://developers.cloudflare.com/workers/languages/python/packages/

## Concrete integration points

All celld locations below refer to the pinned v0.5.1 revision, not the older working checkout.

| Location | Observed behavior | Proposed work |
| --- | --- | --- |
| `crates/celld/deploy.rs:554` (`build`) | Both build paths produce one JS entry plus Wasm siblings; main becomes `index.js`. | Add a Python build path, then retain the existing immutable deployment flow. |
| `crates/celld/protocol.rs:369` (`ModuleKind`) | Only explicit non-default module kind is Wasm. | Design versioned runtime/package metadata and, if needed, Python/data module kinds. |
| `crates/celld/protocol.rs:61` | Required features let old nodes reject incompatible deployments. | Gate native Python deployment support explicitly; include runtime/SDK/package identity in deployment identity. |
| `crates/celld/js/modules.rs:715` (`register_wasm_modules`) | Compiles Wasm and caches compiled code across isolates. | Reuse for interpreter code; keep mutable Python state scoped to the owning isolate. |
| `crates/celld/js.rs` (`Worker::load_config`, around 8263) | Evaluates the entry module, checks rejection, then reads exports and registers classes. | Probe asynchronous interpreter initialization and handler readiness; do not assume top-level await is sufficient. |
| `crates/celld/js.rs`, `js/harness.js`, `runtime.rs` | Existing host event, binding, cancellation, and lifecycle machinery. | Adapt Python calls onto this machinery rather than introducing an independent Python service runtime. |
| `crates/celld/dev.rs` | Local development builds projects and watches changes. | Route Python dev through the same build path and reload source/package changes predictably. |

Cloudflare source inspected at main SHA `761847b67636b6eaed5e0860e98772f8443bed5e` (files fetched from main during investigation):

- `src/pyodide/python-entrypoint.js`: JS entry shim generates wrappers for Python Worker, Durable Object, and Workflow classes.
- `src/pyodide/python-entrypoint-helper.ts`: imports internal metadata, limiter, runtime, and snapshot helpers; explicitly manages Python futures used by `waitUntil`.
- `src/pyodide/internal/python.ts`: custom Emscripten setup, embedded Wasm/stdlib, package mounting, entropy, snapshots, unsafe-eval hooks, and runtime signal handling.
- `src/pyodide/internal/workers-api/src`: `workers` package and ASGI support. The separate `cloudflare/workers-py` repository has `cli`, `runtime-sdk`, and `testlib` packages.

The source supports reuse of concepts and selected components. It does not establish that workerd's bootstrap or the external SDK runs unchanged in celld.

## Architecture choice

Preferred: Python source + pinned runtime/SDK/packages -> JS entry adapter + Pyodide Wasm/data -> celld V8 isolate -> existing celld bindings and persistence.

Compare two bootstrap approaches during the spike:

1. A small adapter around a pinned upstream Pyodide build. Lower initial coupling; must establish what Workers SDK behavior needs adaptation.
2. A narrowly extracted workerd Python bootstrap. Closer reference behavior; substantially more internal host dependencies to replace.

Start with option 1 to establish feasibility. Compare its compatibility gaps against option 2 before expanding the implementation. Preserve upstream licenses and record local patches for any reused components.

Native CPython or a Python subprocess could serve Python HTTP applications, but would require another isolation and I/O bridge design to match Python Workers. Monty-style execution is another distinct product direction. Neither is the initial compatibility plan.

## Ordered implementation slices and completion gates

### 1. Interpreter feasibility, before deployment UX

Use a fresh worktree from the pinned celld release. Pin a Pyodide artifact and record its hash, Python version, ABI, SDK version, and licenses. Supply runtime assets locally; do not depend on CDN downloads during a request.

Use a generated JS wrapper and embedded test source/data if needed to avoid prematurely committing to a new manifest format. Explicitly label this fixture-only packaging.

Prove, through celld's actual HTTP/runtime path:

- CPython boots and executes a standard-library import.
- A Python async handler reads a request and returns a valid celld Response.
- An awaited outbound fetch and a binding call resolve through celld's event loop.
- Concurrent first requests share one initialization attempt; failure is reported consistently without serving a partly initialized worker.
- A tight Python loop can be terminated through the host limit path, and the affected runtime is either safely reusable or discarded.
- Wasm memory growth is visible to pressure handling; measure process RSS as well as reported isolate memory.
- Exceptions include useful Python tracebacks; repeated requests do not accumulate unreleased proxies.

Measure cold startup, warm latency, artifact size, and incremental memory per isolate. Record results before setting performance targets. Compiled-code sharing is not interpreter-state sharing.

Decision: proceed only if the required host changes are bounded and event/resource behavior is credible. A Hello World result alone is insufficient.

### 2. Minimal Python Workers compatibility

Support `from workers import WorkerEntrypoint, Response`, a `Default` class, `self.env`/context, body/headers/status, async fetch, and `waitUntil`. Audit the real SDK's bridge expectations before deciding whether to reuse it directly or provide a documented subset.

Compare the same Python source and semantically equivalent bindings against pinned workerd and celld. The deployment envelopes may differ; record them rather than claiming identical compiled bundles. Cover JSON conversion, binary bodies, exceptions, background work, concurrent calls, and proxy ownership.

### 3. Reproducible packaging and native development

Add `.py` entry detection, local module discovery, and a pinned runtime descriptor. Resolve dependencies at build time, preserve a lock/hash record, and bundle the necessary stdlib and package assets. Start with pure Python packages, then add a specific compatible Wasm wheel.

Reject missing imports, incompatible wheels, unsupported flags/modes, and incomplete runtime assets clearly. Do not silently fall back to the machine's Python. Use a Python capability requirement so old nodes reject unsupported manifests before activation.

Verify reproducible deployment identity, offline startup, dev reload, upgrade/rollback, and rejection by older nodes. Use existing content-addressed storage for immutable assets; evaluate deduplication before embedding large runtimes in every bundle.

### 4. Python Durable Objects

Generate class adapters that delegate to celld's existing Durable Object lifecycle. Define interpreter/instance ownership against actual isolate layout; do not assume one interpreter per HTTP request or per object without checking how celld hosts them.

Start with a SQL-backed counter and alarm. Compare request ordering, transactions, rollback, `blockConcurrencyWhile`, exception paths, and `waitUntil` against workerd. Exercise eviction/recreation and process restart, then ownership transfer/failure scenarios. Acknowledged writes must remain governed by celld's durability gates.

Keep Python in-memory objects ephemeral. Do not add a second SQLite connection or serialize live interpreters into authoritative object state. Add RPC, streaming, WebSocket callbacks/hibernation, and other events as separately tested increments.

### 5. Broader compatibility and optimization

Add an ASGI/FastAPI fixture with pinned dependencies, then the remaining supported bindings/events and Dynamic Workers integration. Publish a tested compatibility matrix rather than changing the service row to an unqualified Yes.

Only after cold-start measurements justify it, investigate interpreter snapshots. Restore requires more than copying Wasm bytes: JS proxies, entropy, filesystem state, and external resources need valid reconstruction. Keep Cloudflare-equivalent snapshot performance outside the first implementation promise.

## Proposed first deliverable

A local, reviewable spike containing one actual Python Worker, a pinned runtime manifest, the smallest necessary loader/adapter changes, a workerd comparison fixture, and measured startup/memory/termination results. Include one binding call so the result proves Workers integration, not just execution of Python code.

The follow-on upstream proposal should show that evidence and its maintenance cost. Maintainer acceptance remains an open question; this investigation did not contact anyone or create an issue/PR.
