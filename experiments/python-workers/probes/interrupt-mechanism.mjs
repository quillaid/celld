// Mechanism probe for Pyodide 0.28.3 interruption under Node. This is not a
// celld test: it establishes what the pinned interpreter itself provides so the
// host adapter does not assume browser-only behavior.
import { loadPyodide } from 'pyodide';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const indexURL = fileURLToPath(new URL('../node_modules/pyodide/', import.meta.url));

if (!isMainThread) {
  const py = await loadPyodide({ indexURL });
  py.setInterruptBuffer(new Int32Array(workerData.sab));
  py.runPython('marker = "kept"; count = 0');
  parentPort.postMessage('spinning');
  let outcome;
  try { py.runPython('while True:\n    count += 1'); outcome = 'returned'; }
  catch (error) { outcome = String(error.type ?? error); }
  parentPort.postMessage({ outcome, after: py.runPython('f"{marker}:{count > 0}"') });
} else {
  const results = {};
  const py = await loadPyodide({ indexURL });
  const m = py._module;
  results.exports = {
    signalHandlingFlag: typeof m._Py_EMSCRIPTEN_SIGNAL_HANDLING,
    signalClock: typeof m.__Py_emscripten_signal_clock,
    stackGetCurrent: typeof m._emscripten_stack_get_current,
    jspi: typeof WebAssembly.Suspending,
  };
  results.idleStack = [m._emscripten_stack_get_current?.()];

  // 1. Plain (non-shared) buffer, written by JS while Python is suspended.
  // The signal is delivered to whichever Python code runs next, which can be
  // the event loop's own timer callback rather than the user's coroutine.
  const uncaught = [];
  const onUncaught = (error) => uncaught.push({ type: error?.type, where: /webloop\.py/.test(String(error)) ? 'webloop' : 'other' });
  process.on('uncaughtException', onUncaught);
  const plain = new Uint8Array(1);
  py.setInterruptBuffer(plain);
  py.runPython('import asyncio\nstate = {"ticks": 0}');
  const run = py.runPythonAsync('while True:\n    state["ticks"] += 1\n    await asyncio.sleep(0.01)');
  await new Promise((r) => setTimeout(r, 100));
  plain[0] = 2;
  results.plainAsync = await Promise.race([
    run.then(() => 'returned', (error) => `rejected:${error.type}`),
    new Promise((r) => setTimeout(() => r('still-pending-after-1s'), 1000)),
  ]);
  results.plainAsyncUncaught = [...uncaught];
  results.plainAsyncNamespace = py.runPython('state["ticks"] > 0');

  // 2. Long await: the signal buffer alone cannot wake a sleeping coroutine.
  plain[0] = 0;
  const sleeper = py.runPythonAsync('await asyncio.sleep(2); "slept"');
  await new Promise((r) => setTimeout(r, 50));
  plain[0] = 2;
  const started = Date.now();
  const keepAlive = setInterval(() => {}, 1000);
  results.longAwait = await Promise.race([
    sleeper.then((value) => `returned:${value}`, (error) => `rejected:${error.type}`),
    new Promise((r) => setTimeout(() => r('never-settled-within-4s'), 4000)),
  ]);
  clearInterval(keepAlive);
  results.longAwaitMs = Date.now() - started;
  results.longAwaitUncaught = uncaught.slice(results.plainAsyncUncaught.length);
  plain[0] = 0;
  process.off('uncaughtException', onUncaught);

  // 3. Task cancellation of a long await, converted by the caller.
  py.runPython(`
import asyncio
async def _probe():
    await asyncio.sleep(60)
task = asyncio.ensure_future(_probe())
`);
  await new Promise((r) => setTimeout(r, 20));
  py.runPython('task.cancel()');
  await new Promise((r) => setTimeout(r, 20));
  results.cancelled = py.runPython('task.cancelled()');

  // 4. Overhead of permanently enabled signal checks on a pure loop.
  const loop = 'def _loop():\n    s = 0\n    for i in range(3_000_000):\n        s += i\n    return s\n_loop()';
  py.setInterruptBuffer(undefined);
  let t = performance.now(); py.runPython(loop); results.loopOffMs = performance.now() - t;
  py.setInterruptBuffer(plain);
  t = performance.now(); py.runPython(loop); results.loopOnMs = performance.now() - t;
  results.idleStack.push(m._emscripten_stack_get_current?.());

  // 5. A second interpreter in the same JS realm.
  const second = await loadPyodide({ indexURL });
  second.runPython('marker = "second"');
  results.secondInstance = { second: second.runPython('marker'), first: py.runPython('marker if "marker" in globals() else None') };

  // 6. Cross-thread writer: Node worker thread spinning synchronously.
  const sab = new SharedArrayBuffer(4);
  const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { sab } });
  const messages = [];
  await new Promise((resolve, reject) => {
    worker.on('message', (message) => {
      messages.push(message);
      if (message === 'spinning') setTimeout(() => { Atomics.store(new Int32Array(sab), 0, 2); }, 200);
      else resolve();
    });
    worker.on('error', reject);
  });
  await worker.terminate();
  results.crossThread = messages.at(-1);
  console.log(JSON.stringify(results, null, 2));
}
