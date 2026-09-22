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
async function initialize({ moduleName, className, files }) {
  const python = await loadPyodide({ indexURL: 'https://python-runtime.invalid/', lockFileContents });
  python.unpackArchive(wheel, 'zip', { extractDir: '/sdk' });
  python.runPython("import sys; sys.path.insert(0, '/sdk')");
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
  const loader = python.globals.get('load_worker');
  try { return loader(moduleName, className); }
  finally { loader.destroy(); }
}
// One initialization and retained dispatcher per generated Worker adapter.
// User instances are created inside each call, so env/context cannot leak from
// the first request into a concurrent request.
export function createPythonWorker({ moduleName, className = 'Default', files }) {
  let ready;
  return { async fetch(request, env, ctx) {
    const handler = await (ready ??= initialize({ moduleName, className, files }));
    const future = handler(ctx, env, 'fetch', request);
    try { return await future; }
    finally { future.destroy(); }
  } };
}
