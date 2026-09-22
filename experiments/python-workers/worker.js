import 'pyodide/pyodide.asm.js';
import { loadPyodide } from 'pyodide';
import lockFileContents from 'pyodide/pyodide-lock.json';
import source from './worker.py';
import durableSource from './durable.py';

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
  python.runPython(durableSource);
  const handler = python.globals.get('handle');
  console.log(JSON.stringify({ event: 'python_ready', elapsedMs: Date.now() - started }));
  return { python, handler };
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname.startsWith('/do/')) {
      const name = new URL(request.url).pathname.split('/')[2];
      return env.PYTHON_COUNTER.getByName(name).fetch(request);
    }
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
        delayStarted: python.globals.get('delay_started'),
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

// Fixture-only class bridge. Object state belongs to this host Durable Object;
// SQL and all ownership/durability behavior remain in celld's existing context.
export class PythonCounter {
  constructor(ctx, env) {
    this.instance = (ready ??= initialize()).then(({ python }) => {
      const klass = python.globals.get('Counter');
      try { return klass(ctx, env); }
      finally { klass.destroy(); }
    });
  }
  async fetch(request) {
    return this.invoke('fetch', request);
  }
  async alarm(info) {
    return this.invoke('alarm', info);
  }
  async invoke(method, argument) {
    const instance = await this.instance;
    const handler = instance[method];
    try {
      const future = handler(argument);
      try {
        const response = await future;
        if (response instanceof Response) response.headers.set('x-python-instance-id', instanceId);
        return response;
      } finally { future.destroy(); }
    } finally { handler.destroy(); }
  }
}
