// Python host adapter: one small interface between an embedding host and the
// pinned Pyodide interpreter. The host can be a celld or workerd Worker, a
// Durable Object, a browser Web Worker, or Node.
//
// The adapter owns interpreter initialization, verified package installation,
// per-session namespaces, structured execution results, cooperative
// interruption, and detection of destructive termination. The embedding host
// supplies `loadRuntime`, which returns a Pyodide instance built from assets
// that the host bundles. The adapter never downloads anything.
//
// Two different stop operations exist, and the adapter keeps them apart:
//   interrupt(session) raises KeyboardInterrupt (or cancels at an await) in
//     that session's execution. The namespace and the interpreter survive.
//   destructive termination (the host kills JS execution, for example through
//     a CPU limit or ctx.abort()) leaves the Wasm interpreter in an unknown
//     state. The adapter detects that state, fails pending executions, and
//     starts a new interpreter. Every namespace is lost.

import runnerSource from './python_host.py';

const SIGINT = 2;
const HEALTH_POLL_MS = 100;

const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function verifyArtifact(bytes, sha256) {
  const actual = hex(await crypto.subtle.digest('SHA-256', bytes));
  if (actual !== sha256) throw new Error(`Python package hash mismatch: expected ${sha256}, got ${actual}`);
}

// A host that can write memory from another thread passes `signals`: an
// Int32Array(2) whose index 0 is the CPython signal slot and index 1 is the
// target execution id (0 = the execution that runs now). A shared buffer is
// only useful when another thread really writes it. Nothing here assumes that
// SharedArrayBuffer or cross-thread writers exist.
// `onRunning(session, executionId)` reports the execution that a cross-thread
// writer should target for a session (0 when the session is idle).
export function createPythonHost({ loadRuntime, packages = [], dynamicLibraries = [], signals = null, onRunning = () => {}, onEvent = () => {}, detectTermination = true }) {
  let generation = 0;
  let current = null; // { generation, pyodide, host, idleStack, pending:Set, dead }
  let starting = null;
  const invalidations = [];
  const bindings = new Map(); // session -> { values: Map<name, value>, generation }
  const running = new Map(); // session -> execution ids, in start order

  function publish(session) {
    const ids = running.get(session);
    onRunning(session, ids?.length ? ids[ids.length - 1] : 0);
  }

  function applyBindings(rt, session) {
    const entry = bindings.get(session);
    if (!entry || entry.generation === rt.generation) return;
    for (const [name, value] of entry.values) enter(rt, () => rt.host.bind(session, name, value));
    entry.generation = rt.generation;
  }

  async function start() {
    const id = ++generation;
    const started = Date.now();
    const pyodide = await loadRuntime();
    const module = pyodide._module;
    const idleStack = typeof module._emscripten_stack_get_current === 'function'
      ? module._emscripten_stack_get_current() : null;
    if (packages.length) {
      pyodide.FS.mkdirTree('/packages');
      for (const artifact of packages) {
        await verifyArtifact(artifact.bytes, artifact.sha256);
        pyodide.unpackArchive(artifact.bytes, 'zip', { extractDir: '/packages' });
      }
      pyodide.runPython("import sys, importlib; sys.path.insert(0, '/packages'); importlib.invalidate_caches()");
      if (dynamicLibraries.length) {
        pyodide.runPython("import os; os.environ['LD_LIBRARY_PATH'] = '/packages:' + os.environ.get('LD_LIBRARY_PATH', '')");
      }
      // Pinned 0.28.3 private hook, audited with the runtime version.
      for (const path of dynamicLibraries) await pyodide._api.loadDynlib('/packages/' + path);
    }
    pyodide.FS.mkdirTree('/python_host');
    pyodide.FS.writeFile('/python_host/python_host.py', runnerSource);
    pyodide.runPython("import sys; sys.path.insert(0, '/python_host')");
    const host = pyodide.pyimport('python_host');
    // Entry marker: incremented around every Python entry the adapter makes
    // and around every asyncio handle, decremented only on return or throw.
    // A host termination unwinds without running catch or finally blocks,
    // so a nonzero value at a top-level host event means Python never
    // returned. (Confirmed for celld ctx.abort(); see PROGRESS-v0.6.0.md.)
    const entries = new Int32Array(1);
    let signalTarget = null;
    if (signals) {
      signalTarget = () => Atomics.load(signals, 1);
      pyodide.setInterruptBuffer(signals);
    }
    host.install(signalTarget, entries);
    const runtime = { generation: id, pyodide, module, host, idleStack, entries, pending: new Set(), dead: null, startedMs: Date.now() - started, stackSamples: [] };
    onEvent({ event: 'python_ready', generation: id, elapsedMs: runtime.startedMs });
    return runtime;
  }

  // Called only at top-level host events (never from JS that Python called).
  // A nonzero entry marker there means a Python entry was torn down. The
  // interpreter's C state is then not trustworthy and is never entered again.
  // The Emscripten stack pointer is sampled for diagnostics only: under JSPI
  // it drifts in normal operation (see PROGRESS-v0.6.0.md), so it cannot be
  // the invariant.
  function check(runtime) {
    if (runtime.dead) return false;
    if (runtime.idleStack !== null) {
      runtime.stackSamples.push(runtime.module._emscripten_stack_get_current());
      if (runtime.stackSamples.length > 16) runtime.stackSamples.shift();
    }
    if (!detectTermination || runtime.entries[0] === 0) return true;
    invalidate(runtime, `Python entry did not return (marker ${runtime.entries[0]}); the host terminated execution inside Python`);
    return false;
  }

  // Every adapter call into Python goes through here. Deliberately not
  // try/finally: the decrement must not run when a termination unwinds.
  function enter(runtime, call) {
    runtime.entries[0]++;
    let result;
    try { result = call(); }
    catch (error) { runtime.entries[0]--; throw error; }
    runtime.entries[0]--;
    return result;
  }

  function invalidate(runtime, reason, detail = undefined) {
    if (runtime.dead) return;
    runtime.dead = reason;
    invalidations.push({ generation: runtime.generation, reason, detail, at: new Date().toISOString() });
    onEvent({ event: 'python_invalidated', generation: runtime.generation, reason });
    for (const settle of runtime.pending) settle({ status: 'invalidated', generation: runtime.generation, reason });
    runtime.pending.clear();
    if (current === runtime) current = null;
    // The dead interpreter keeps its memory until its remaining JS callbacks
    // are collected. The adapter drops every reference it owns.
  }

  async function runtime() {
    if (current && check(current)) return current;
    starting ??= start().then(
      (value) => { current = value; starting = null; return value; },
      (error) => { starting = null; throw error; },
    );
    return starting;
  }

  function withHealthPoll(rt, promise) {
    // A suspended execution's continuation may never run after its
    // interpreter dies. Poll the invariant so the caller gets an answer.
    return new Promise((resolve, reject) => {
      const settle = (result) => { clearInterval(timer); rt.pending.delete(settle); resolve(result); };
      rt.pending.add(settle);
      const timer = setInterval(() => { check(rt); }, HEALTH_POLL_MS);
      promise.then((value) => settle(value), (error) => { clearInterval(timer); rt.pending.delete(settle); reject(error); });
    });
  }

  return {
    capabilities() {
      return {
        interrupt: {
          suspended: 'task-cancel',
          running: signals ? 'signal-buffer' : 'unavailable-without-cross-thread-writer',
        },
        termination: { detection: 'python-entry-marker', recovery: 'new-interpreter', namespacesPreserved: false },
        host: {
          sharedArrayBuffer: typeof SharedArrayBuffer === 'function',
          crossOriginIsolated: globalThis.crossOriginIsolated ?? null,
          jspi: typeof globalThis.WebAssembly?.Suspending === 'function',
        },
        // Whether this interpreter uses stack switching (the bundle may hide
        // host JSPI from Pyodide; see runtime-assets.js).
        stackSwitching: current ? !!current.module.jspiSupported : null,
      };
    },
    async ready() {
      const rt = await runtime();
      const version = enter(rt, () => rt.pyodide.runPython('import sys; sys.version.split()[0]'));
      return { generation: rt.generation, python: version, pyodide: rt.pyodide.version, startedMs: rt.startedMs };
    },
    async execute(session, code) {
      const rt = await runtime();
      applyBindings(rt, session);
      const started = enter(rt, () => rt.host.execute(session, code));
      let id, task;
      try { [id, task] = started.toJs({ depth: 1 }); }
      finally { started.destroy(); }
      if (!running.has(session)) running.set(session, []);
      running.get(session).push(id);
      publish(session);
      const run = (async () => {
        try {
          const result = await task;
          try { return result.toJs({ dict_converter: Object.fromEntries }); }
          finally { result.destroy(); }
        } finally { task.destroy(); }
      })();
      let result;
      try { result = await withHealthPoll(rt, run); }
      finally {
        const ids = running.get(session);
        ids.splice(ids.indexOf(id), 1);
        if (!ids.length) running.delete(session);
        publish(session);
      }
      return { generation: rt.generation, ...result, execution: result.execution ?? id };
    },
    async interrupt(session) {
      if (!current || !check(current)) return { interrupted: [], generation: current?.generation ?? null };
      const rt = current;
      const ids = enter(rt, () => rt.host.interrupt(session));
      try { return { interrupted: ids.toJs(), generation: rt.generation, mode: 'task-cancel' }; }
      finally { ids.destroy(); }
    },
    // For hosts with a cross-thread writer: the id that thread should target.
    runningExecution(session) {
      if (!current || !check(current)) return 0;
      const rt = current;
      return enter(rt, () => rt.host.running_execution(session));
    },
    // Expose one host object to one session. Notebook code sees only what the
    // host binds; the adapter never injects host globals on its own.
    // Bindings belong to the host, so a new interpreter receives them again.
    bind(session, name, value) {
      if (!bindings.has(session)) bindings.set(session, { values: new Map(), generation: null });
      const entry = bindings.get(session);
      entry.values.set(name, value);
      entry.generation = null;
    },
    async session(session) {
      const rt = await runtime();
      const info = enter(rt, () => rt.host.session_info(session));
      try { return { generation: rt.generation, info: info?.toJs({ dict_converter: Object.fromEntries }) ?? null }; }
      finally { info?.destroy?.(); }
    },
    async dispose(session) {
      bindings.delete(session);
      if (!current || !check(current)) return false;
      const rt = current;
      return enter(rt, () => rt.host.dispose(session));
    },
    status() {
      return {
        generation: current?.generation ?? null, alive: !!current && !current.dead, invalidations: [...invalidations],
        entries: current ? current.entries[0] : null,
        stack: current ? { idle: current.idleStack, base: current.module._emscripten_stack_get_base?.(), samples: [...current.stackSamples] } : null,
      };
    },
    // Test and host hook: run a JS function with the interpreter's module,
    // for example to request a destructive termination from inside Python.
    get pyodide() { return current?.pyodide ?? null; },
  };
}

export { SIGINT };
