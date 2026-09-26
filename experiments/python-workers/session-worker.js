// celld fixture: notebook-style Python sessions in Durable Objects, through
// the python-host adapter. Routes:
//   POST /s/<name>/execute     body = Python source
//   POST /s/<name>/interrupt
//   GET  /s/<name>/info
//   POST /w/execute            stateless Worker session (per isolate)
//
// Each Durable Object instance owns one session. Every object in this isolate
// shares one interpreter. The namespace is ephemeral: its lifetime follows the
// object instance, and a new instance starts with an empty namespace. Durable
// state belongs in ctx.storage, which the session receives as an explicit
// binding.
import 'pyodide/pyodide.asm.js';
import { loadPyodide } from 'pyodide';
import lockFileContents from 'pyodide/pyodide-lock.json';
import { DurableObject } from 'cloudflare:workers';
import { createPythonHost } from './python-host.js';
import { packages, dynamicLibraries } from 'celld-python-packages';

const isolate = crypto.randomUUID();
let host;
function pythonHost() {
  return host ??= createPythonHost({
    loadRuntime: () => loadPyodide({ indexURL: 'https://python-runtime.invalid/', lockFileContents }),
    packages, dynamicLibraries,
    onEvent: (event) => console.log(JSON.stringify({ isolate, ...event })),
  });
}

// Object id -> the session of its live instance in this isolate.
const liveSessions = new Map();

async function respond(meta, work) {
  try {
    return Response.json({ ...meta, ...(await work) });
  } catch (error) {
    return Response.json({ ...meta, status: 'host-error', error: String(error), stack: error?.stack }, { status: 500 });
  }
}

export class PythonSession extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const objectId = ctx.id.toString();
    this.instance = crypto.randomUUID();
    this.session = `${objectId}:${this.instance}`;
    const previous = liveSessions.get(objectId);
    liveSessions.set(objectId, this.session);
    const python = pythonHost();
    // A previous instance in this isolate left its namespace behind; its
    // lifetime ended with that instance.
    this.cleanup = previous ? python.dispose(previous).then((existed) => ({ previous, existed })) : Promise.resolve(null);
    python.bind(this.session, 'ctx', ctx);
    python.bind(this.session, 'env', env);
  }

  async fetch(request) {
    const python = pythonHost();
    const op = new URL(request.url).pathname.split('/').pop();
    const cleanup = await this.cleanup;
    const meta = { isolate, objectInstance: this.instance, session: this.session, previousSession: cleanup };
    if (op === 'execute') return respond(meta, python.execute(this.session, await request.text()));
    if (op === 'interrupt') return respond(meta, python.interrupt(this.session));
    if (op === 'info') {
      return respond(meta, (async () => ({
        ...(await python.session(this.session)), status: python.status(), capabilities: python.capabilities(),
        previousInfo: cleanup ? (await python.session(cleanup.previous)).info : undefined,
      }))());
    }
    return new Response('unknown operation', { status: 404 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/');
    if (parts[1] === 's') return env.SESSIONS.getByName(parts[2]).fetch(request);
    if (url.pathname === '/probe/async-entries') {
      // Fixture-only probe: Emscripten stack depth across awaited async
      // Python entries (JSPI stack switching when the host provides it).
      const python = pythonHost();
      await python.ready();
      const module = python.pyodide._module;
      const call = python.pyodide.runPython('async def _probe():\n    return 1\n_probe');
      const base = module._emscripten_stack_get_base();
      const samples = [];
      const n = Number(url.searchParams.get('n') || 1000);
      try {
        for (let i = 0; i <= n; i++) {
          await call();
          if (i % Math.max(1, Math.floor(n / 4)) === 0) samples.push([i, base - module._emscripten_stack_get_current()]);
        }
      } finally { call.destroy(); }
      return Response.json({ isolate, hostJspi: typeof globalThis.WebAssembly.Suspending === 'function', stackSwitching: !!module.jspiSupported, stackSize: base - module._emscripten_stack_get_end(), depthBelowBase: samples });
    }
    if (url.pathname === '/w/execute') {
      return respond({ isolate }, pythonHost().execute('worker', await request.text()));
    }
    return new Response('not found', { status: 404 });
  },
};
