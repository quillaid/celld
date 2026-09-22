# Pending framework qualification

This pinned manifest is a reproducible packaging probe, not a working FastAPI
deployment. Pydantic and AnyIO versions match the pinned Pyodide 0.28.3 index;
FastAPI and Starlette are explicitly selected compatible versions.

From the experiment directory, run:

```
node lock-packages.mjs fastapi
```

The first attempt failed because Pyodide's AnyIO index omitted the wheel's
`idna` requirement. The resolver now completes wheel-metadata dependencies.
The remaining rejection is `Shared-library archives are not yet supported:
libopenssl`. AnyIO brings in the runtime's SSL module, which depends on
`libopenssl-1.1.1w.zip` installed as shared libraries rather than a Python wheel.
No partial lock is published.

Next: package pinned shared-library archives with safe paths, deterministic
dependency-ordered loading, immutable Wasm assets and deployment identity;
then exercise FastAPI HTTP validation against the pinned workerd reference.
Do not drop SSL/OpenSSL from the closure just to make this fixture build.
