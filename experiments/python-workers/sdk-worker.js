import 'pyodide/pyodide.asm.js';
import { loadPyodide } from 'pyodide';
import lockFileContents from 'pyodide/pyodide-lock.json';
import wheel from './.celld/workers_runtime_sdk-1.9.0-py3-none-any.whl';
import source from './sdk-worker.py';

let ready;
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
async function initialize() {
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
  python.runPython(source);
  return python.globals.get('dispatch_sdk');
}
export default { async fetch(request, env, ctx) {
  const handler = await (ready ??= initialize());
  const future = handler(request, env, ctx);
  try { return await future; }
  finally { future.destroy(); }
} };
