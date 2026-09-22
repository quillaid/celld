import 'pyodide/pyodide.asm.js';
import { loadPyodide } from 'pyodide';
import lockFileContents from 'pyodide/pyodide-lock.json';
import wheel from './.celld/workers_runtime_sdk-1.9.0-py3-none-any.whl';
import adapter from './sdk-dispatch.py';
import { DurableObject as HostDurableObject } from 'cloudflare:workers';
import * as cloudflareWorkers from 'cloudflare:workers';

const patched = new WeakSet();
function retainedAwaitable(value) {
  const owned = typeof value?.copy === 'function' ? value.copy() : value;
  return (async () => {
    try { await owned; }
    finally { owned?.destroy?.(); }
  })();
}
function patchWaitUntil(ctx) {
  if (patched.has(ctx)) return;
  const waitUntil = ctx.waitUntil.bind(ctx);
  ctx.waitUntil = (value) => {
    // A Python-to-JS argument is borrowed. Retain it synchronously before
    // returning to Python, then release the owned proxy after settlement.
    waitUntil(retainedAwaitable(value));
  };
  patched.add(ctx);
}
async function initialize({ files, packages = [], dynamicLibraries = [] }) {
  const python = await loadPyodide({ indexURL: 'https://python-runtime.invalid/', lockFileContents });
  python.unpackArchive(wheel, 'zip', { extractDir: '/sdk' });
  python.runPython("import sys; sys.path.insert(0, '/sdk')");
  for (const bytes of packages) python.unpackArchive(bytes, 'zip', { extractDir: '/packages' });
  if (packages.length) python.runPython("sys.path.insert(1, '/packages')");
  if (dynamicLibraries.length) python.runPython("import os; os.environ['LD_LIBRARY_PATH'] = '/packages:' + os.environ.get('LD_LIBRARY_PATH', '')");
  for (const path of dynamicLibraries) await python._api.loadDynlib('/packages/' + path);
  python.registerJsModule('_cloudflare_compat_flags', { python_workflows_implicit_dependencies: false });
  python.registerJsModule('_pyodide_entrypoint_helper', {
    patchWaitUntil,
    cloudflareWorkersModule: {
      ...cloudflareWorkers,
      waitUntil(value) { cloudflareWorkers.waitUntil(retainedAwaitable(value)); },
    },
    // These hooks are deliberately explicit failures until their host contract
    // is implemented; basic SDK HTTP must not silently emulate them.
    doAnImport(name) { throw new Error(`SDK JavaScript module import not implemented: ${name}`); },
    patch_env_helper() { throw new Error('SDK patch_env is not implemented'); },
  });
  python.FS.mkdirTree('/app');
  for (const [name, contents] of Object.entries(files)) {
    if (!/^(?:[a-zA-Z_][a-zA-Z_0-9]*\/)*[a-zA-Z_][a-zA-Z_0-9]*\.py$/.test(name)) throw new Error('Invalid Python module filename: ' + name);
    python.FS.mkdirTree('/app/' + name.split('/').slice(0, -1).join('/'));
    python.FS.writeFile('/app/' + name, contents);
  }
  python.runPython("sys.path.insert(0, '/app')");
  python.runPython(adapter);
  return { loadWorker: python.globals.get('load_worker'), loadDurable: python.globals.get('load_durable') };
}

export function createPythonDeployment({ moduleName, files, packages, dynamicLibraries }) {
  let ready;
  const durableHandlers = new Set();
  const runtime = () => ready ??= initialize({ moduleName, files, packages, dynamicLibraries });
  async function invoke(handler, ...args) {
    // Destroying a proxy may execute Python __del__. Do this only inside an
    // admitted guest event, never from host-side residency teardown (which
    // also runs after hard termination of an unsafe interpreter).
    for (const record of durableHandlers) {
      if (!record.ctx.__celldReleased && !record.ctx._aborted) continue;
      durableHandlers.delete(record);
      record.handler.destroy();
    }
    const future = handler(...args);
    try { return await future; }
    finally { future.destroy(); }
  }
  return {
    worker(className = 'Default') {
      let handler;
      return { async fetch(request, env, ctx) {
        const { loadWorker } = await runtime();
        handler ??= loadWorker(moduleName, className);
        return invoke(handler, ctx, env, 'fetch', request);
      } };
    },
    durableObject(className) {
      return class extends HostDurableObject {
        #handler;
        #ready;
        constructor(ctx, env) {
          super(ctx, env);
          this.#ready = ctx.blockConcurrencyWhile(async () => {
            const { loadDurable } = await runtime();
            this.#handler = loadDurable(moduleName, className, ctx, env);
            durableHandlers.add({ ctx, handler: this.#handler });
            const methods = this.#handler.rpc_methods;
            try {
              for (const name of methods.toJs()) {
                if (['fetch', 'alarm', 'constructor', 'then', 'ctx', 'env'].includes(name)) continue;
                Object.defineProperty(this, name, { value: (...args) => invoke(this.#handler, name, ...args) });
              }
            } finally { methods.destroy(); }
          });
        }
        async fetch(request) { await this.#ready; return invoke(this.#handler, 'fetch', request); }
        async alarm(info) { await this.#ready; return invoke(this.#handler, 'alarm', info); }
      };
    },
  };
}
export function createPythonWorker({ className = 'Default', ...options }) {
  return createPythonDeployment(options).worker(className);
}
