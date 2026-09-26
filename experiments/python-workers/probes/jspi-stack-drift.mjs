// Emscripten stack depth across awaited async Python entries.
//   node probes/jspi-stack-drift.mjs [pyodide-dir]
//   node --experimental-wasm-jspi probes/jspi-stack-drift.mjs [pyodide-dir]
// With Node 22's JSPI flag, pinned Pyodide 0.28.3 loses 48 bytes per call;
// 314.0.7 does not (see PROGRESS-v0.6.0.md, section 5).
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? fileURLToPath(new URL('../node_modules/pyodide', import.meta.url)));
const { loadPyodide } = await import(pathToFileURL(resolve(dir, 'pyodide.mjs')).href);
const py = await loadPyodide({ indexURL: dir + '/' });
const m = py._module;
const base = m._emscripten_stack_get_base();
const call = py.runPython('async def af():\n  return 1\naf');
const stackSwitching = await py.runPythonAsync('from pyodide.ffi import can_run_sync; can_run_sync()');
const samples = [];
for (let i = 0; i <= 20000; i++) {
  await call();
  if (i % 5000 === 0) samples.push([i, base - m._emscripten_stack_get_current()]);
}
console.log(JSON.stringify({ pyodide: py.version, stackSwitching, stackSize: base - m._emscripten_stack_get_end(), depthBelowBase: samples }));
