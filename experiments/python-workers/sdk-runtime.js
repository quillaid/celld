import 'pyodide/pyodide.asm.js';
import { loadPyodide } from 'pyodide';
import lockFileContents from 'pyodide/pyodide-lock.json';
import wheel from './.celld/workers_runtime_sdk-1.9.0-py3-none-any.whl';
import adapter from './sdk-dispatch.py';

const patched = new WeakSet();
function patchWaitUntil(ctx) {
  if (patched.has(ctx)) return;
  const waitUntil = ctx.waitUntil.bind(ctx);
  ctx.waitUntil = (value) => {
    // A Python-to-JS argument is borrowed. Retain it synchronously before
    // returning to Python, then release the owned proxy after settlement.
    const owned = typeof value?.copy === 'function' ? value.copy() : value;
    waitUntil((async () => {
      try { await owned; }
      finally { owned?.destroy?.(); }
    })());
  };
  patched.add(ctx);
}
async function initialize({ files, packages = [], dynamicLibraries = [] }) {
  const python = await loadPyodide({ indexURL: 'https://python-runtime.invalid/', lockFileContents });
  python.unpackArchive(wheel, 'zip', { extractDir: '/sdk' });
  python.runPython("import sys; sys.path.insert(0, '/sdk')");
  for (const bytes of packages) python.unpackArchive(bytes, 'zip', { extractDir: '/packages' });
  if (packages.length) python.runPython("sys.path.insert(1, '/packages')");
  for (const path of dynamicLibraries) await python._api.loadDynlib('/packages/' + path);
  python.registerJsModule('_cloudflare_compat_flags', { python_workflows_implicit_dependencies: false });
  python.registerJsModule('_pyodide_entrypoint_helper', {
    patchWaitUntil,
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
  const runtime = () => ready ??= initialize({ moduleName, files, packages, dynamicLibraries });
  async function invoke(handler, ...args) {
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
      return class {
        constructor(ctx, env) {
          this.handler = runtime().then(({ loadDurable }) => loadDurable(moduleName, className, ctx, env));
        }
        async fetch(request) { return invoke(await this.handler, 'fetch', request); }
        async alarm(info) { return invoke(await this.handler, 'alarm', info); }
      };
    },
  };
}
export function createPythonWorker({ className = 'Default', ...options }) {
  return createPythonDeployment(options).worker(className);
}
