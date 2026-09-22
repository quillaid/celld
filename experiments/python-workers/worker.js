import 'pyodide/pyodide.asm.js';
import { loadPyodide } from 'pyodide';
import lockFileContents from 'pyodide/pyodide-lock.json';
import source from './worker.py';

let ready;
let initializationCount = 0;
let instanceId;
const startupLog = [];
async function initialize() {
  initializationCount++;
  instanceId = crypto.randomUUID();
  const started = Date.now();
  const python = await loadPyodide({
    indexURL: 'https://python-runtime.invalid/', lockFileContents,
    stdout: (line) => startupLog.push(String(line)),
    stderr: (line) => startupLog.push(String(line)),
  });
  python.runPython(source);
  const handler = python.globals.get('handle');
  console.log(JSON.stringify({ event: 'python_ready', elapsedMs: Date.now() - started }));
  return { python, handler };
}

export default {
  async fetch(request, env) {
    let handler, python;
    try {
      ({ handler, python } = await (ready ??= initialize()));
    } catch (error) {
      return Response.json({ phase: 'initialization', error: String(error), stack: error.stack, startupLog }, { status: 500 });
    }
    // Fixture-only introspection: synchronous Python remains callable even
    // when a hard termination has abandoned an asyncio task.
    if (new URL(request.url).pathname === '/__diagnostics') {
      return Response.json({
        instance: instanceId,
        currentTasks: python.runPython('repr(__import__("asyncio").tasks._current_tasks)'),
        startupLog,
      });
    }
    const result = handler(request, env);
    try {
      const response = await result;
      response.headers.set('x-python-initializations', String(initializationCount));
      response.headers.set('x-python-instance-id', instanceId);
      response.headers.set('x-python-linear-memory', String(python._module.HEAPU8.byteLength));
      return response;
    } finally {
      result.destroy();
    }
  },
};
