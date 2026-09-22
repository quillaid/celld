# Workers SDK bridge audit

Inspected 2026-09-21. The released `workers-runtime-sdk` 1.9.0 wheel is the
executable contract for this experiment. `sdk-lock.json` pins its URL and SHA-256;
`fetch-sdk.mjs` verifies cached and downloaded bytes. The wheel is unmodified and
bundled locally. Interpreter startup and SDK import need no package download.

Sources:
- [Published package metadata](https://pypi.org/pypi/workers-runtime-sdk/1.9.0/json)
- [SDK source at e5cf461](https://github.com/cloudflare/workers-py/tree/e5cf461540e94f2065398ced7ed8031ac504dc3a/packages/runtime-sdk)
- [Legacy workerd SDK notice](https://github.com/cloudflare/workerd/blob/761847b67636b6eaed5e0860e98772f8443bed5e/src/pyodide/internal/workers-api/src/workers/__init__.py)
- [workerd host helper](https://github.com/cloudflare/workerd/blob/761847b67636b6eaed5e0860e98772f8443bed5e/src/pyodide/python-entrypoint-helper.ts)

Release metadata declares MIT licensing and no package dependencies. The wheel
includes Python files and companion JavaScript modules; their presence is not
proof that all paths execute in celld. Downloaded wheel and generated bundles
remain in ignored `.celld/` and `dist/` directories.

## Host seams

| Seam | Current experiment | Remaining work |
| --- | --- | --- |
| `WorkerEntrypoint(ctx, env)` | Real SDK class; native `.py` build path generates exports and environment wrapper handles actual KV | Additional events, named service entrypoints and broader discovery |
| SDK Request / Response | Real conversions; JSON/status/headers, binary bodies, incremental identity-encoded response and upload streaming, buffered request-body passthrough, and response/upload disconnect cleanup verified | Application-driven cancellation, forms, cloning and larger body matrix |
| `patchWaitUntil` helper | Retains borrowed Python awaitable synchronously; destroys owned proxy after settlement; delegates to celld context | Cancellation, rejection, DO contexts and leak accounting |
| Durable Object handler proxies | Eight shared-interpreter evictions return the Python weak-reference census to one survivor and finalize each retired instance once; Dynamic Worker facet finalizer loop reaches configured CPU limit and replacement restores acknowledged SQL | Retained tracebacks, returned RPC capabilities, other adversarial finalizers and long-run bounds |
| `_cloudflare_compat_flags` | Explicit historical fixture setting for Workflow dependencies; missing flags remain absent | Validate/map supported dates and flags |
| `cloudflareWorkersModule`, `cloudflareSocketsModule` | Workers module supplied; retained module-level wait_until and env/KV verified through concurrent ASGI lifespan requests | Sockets module, other module exports and cross-binding request isolation |
| SDK ASGI adapter | Unmodified adapter handles concurrent request bodies, decoded paths/query, status/headers, two-chunk response path and observable lifespan startup/shutdown against workerd | Framework dependencies, causal streaming/backpressure, WebSockets and disconnect behavior |
| `doAnImport` | Explicit unsupported error | Permitted JS imports and SDK companion modules |
| `patch_env_helper` | Explicit unsupported error | Context-local patch semantics |
| Package `.pth` hooks | Not run by unpacking wheel into `/sdk` | Audit/install entropy and package patches before framework support |
| Application packages | Locked pure wheels bundled for native dev/deploy; humanize/dateutil/six HTTP/offline startup, package reload and same-wheel workerd comparison tested | Framework behavior; .pth and .data layouts explicitly rejected |
| Compiled extensions | Exact cp313/Pyodide 2025_0 wheel tags; immutable Wasm imports and pinned `_api.loadDynlib`; MarkupSafe C function passes celld HTTP/offline startup and same-extension/SDK-digest workerd comparison | Multi-library graphs, reload and pressure; other wheels/workloads unqualified |
| SDK DurableObject / WorkflowEntrypoint | Native DO fetch/alarm, bounded method RPC, WebSocket text/binary input/output, clean close, abrupt EOF, forced/automatic-idle local live-socket eviction and auto-response without residency tested separately | Pressure-driven hibernation, ownership migration, protocol-error callback parity, late-added/descriptor RPC methods, properties/capabilities, cross-node RPC, Workflow bridge and proxy bounds |

`sdk-runtime.js` now loads ordinary application modules under `/app`. Its
`sdk-dispatch.py` adapter validates the selected WorkerEntrypoint class, creates
a request-scoped instance, and uses the SDK's argument/result conversions.
Application source needs no celld-specific dispatch function. This remains an
experimental adapter used by the native `.py` build path through the configured
external builder; it is not a bundled production toolchain.

## Reference envelope and proof

Both engines execute unchanged `sdk-worker.py` against the same wheel's Python
files. Celld unpacks the wheel in its Pyodide filesystem. Workerd mounts the
wheel's `workers/*.py` under `/session/metadata/python_modules` as data modules.
Workerd 1.20260922.1 uses compatibility date 2025-06-01 with an
`on_fetch = fetch` alias for historical dispatch. This is not latest-date proof.

A request hashes the actual loaded `workers.entrypoints` file in each engine;
both must equal the file extracted from the pinned wheel. Status, response
header and response bytes compare exactly for JSON and binary cases. Background
KV completion is polled independently in both engines before asserting the same
final value, because completion times need not be identical.

Native build/dev/deploy inputs, dependency resolution/locks, older-node feature
fencing, reload, and the larger compatibility matrix remain unimplemented here.

The dispatch comparison additionally checks eight concurrent requests with
instance-local state, application exceptions, successful calls after an error,
and application filenames in celld tracebacks. It consumes each transport body
within its request deadline before waiting for the other engine to cold-start.
