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
    let handler;
    try {
      ({ handler } = await (ready ??= initialize()));
    } catch (error) {
      return Response.json({ phase: 'initialization', error: String(error), stack: error.stack, startupLog }, { status: 500 });
    }
    const result = handler(request, env);
    try {
      const response = await result;
      response.headers.set('x-python-initializations', String(initializationCount));
      response.headers.set('x-python-instance-id', instanceId);
      return response;
    } finally {
      result.destroy();
    }
  },
};
