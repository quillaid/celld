# FastAPI qualification fixture

Pydantic and AnyIO versions match the pinned Pyodide 0.28.3 index;
FastAPI and Starlette are explicitly selected compatible versions.

From the experiment directory, run:

```
node lock-packages.mjs fastapi
npm run test:fastapi
```

The first attempt failed because Pyodide's AnyIO index omitted the wheel's
`idna` requirement. The resolver now completes wheel-metadata dependencies.
The next rejection was the unsupported OpenSSL archive. AnyIO brings in the
runtime's SSL module, which depends on
`libopenssl-1.1.1w.zip` installed as shared libraries rather than a Python wheel.
The archive now participates in the lock, hash validation, dependency order,
safe extraction and immutable Wasm packaging. Historical failure evidence is
retained under `evidence/2026-09-21-fastapi-archive-rejection.txt`.

The fixture compares async HTTP routes, body/path/query validation errors,
OpenAPI and Pydantic/_ssl extension digests against pinned workerd. The same
requests also pass with celld runtime networking disabled. SSLContext construction
is tested; TLS networking, synchronous endpoints/thread pools, background tasks,
framework WebSockets and broad framework compatibility remain unqualified.
