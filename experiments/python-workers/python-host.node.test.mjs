// Adapter contract under Node with the pinned Pyodide. These tests check the
// adapter itself; the celld tests check the same adapter inside a real host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { loadPyodide } from 'pyodide';
import { bundledAdapter, indexURL, lockedPackages } from './python-host-helpers.mjs';

const { createPythonHost } = await bundledAdapter();
const { packages, dynamicLibraries } = await lockedPackages();
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

test('python host adapter in one Node thread', { timeout: 120000 }, async (t) => {
  const events = [];
  const host = createPythonHost({
    loadRuntime: () => loadPyodide({ indexURL }), packages, dynamicLibraries,
    onEvent: (event) => events.push(event),
  });
  const [a, b] = await Promise.all([host.ready(), host.ready()]);

  await t.test('concurrent first calls share one initialization', () => {
    assert.equal(a.generation, 1);
    assert.equal(b.generation, 1);
    assert.equal(a.python, '3.13.2');
    assert.equal(events.filter((event) => event.event === 'python_ready').length, 1);
  });

  await t.test('execution returns the last expression, output, and a counter', async () => {
    const first = await host.execute('a', 'x = 40\nprint("hello")\nx + 2');
    assert.equal(first.status, 'ok');
    assert.equal(first.value, '42');
    assert.equal(first.stdout, 'hello\n');
    assert.equal(first.count, 1);
    const second = await host.execute('a', 'x');
    assert.equal(second.value, '40');
    assert.equal(second.count, 2);
  });

  await t.test('sessions have separate namespaces', async () => {
    const other = await host.execute('b', 'x');
    assert.equal(other.status, 'error');
    assert.equal(other.error.type, 'NameError');
  });

  await t.test('Python errors are structured and keep the namespace', async () => {
    const error = await host.execute('a', 'def f():\n    return 1 / 0\nf()');
    assert.equal(error.status, 'error');
    assert.equal(error.error.type, 'ZeroDivisionError');
    assert.match(error.error.traceback, /<session a #3>", line 2, in f/);
    assert.doesNotMatch(error.error.traceback, /python_host\.py|_pyodide/);
    const syntax = await host.execute('a', 'def (:');
    assert.equal(syntax.error.type, 'SyntaxError');
    assert.equal((await host.execute('a', 'x')).value, '40');
  });

  await t.test('locked pure and compiled packages load from verified bytes', async () => {
    const result = await host.execute('a', [
      'import humanize, markupsafe, markupsafe._speedups as s',
      '(humanize.intcomma(1234567), str(markupsafe.escape("<a>")), s.__file__.endswith(".so"))',
    ].join('\n'));
    assert.equal(result.status, 'ok', JSON.stringify(result));
    assert.equal(result.value, "('1,234,567', '&lt;a&gt;', True)");
  });

  await t.test('interrupting a suspended execution keeps its namespace and its neighbors', async () => {
    const slow = host.execute('a', 'import asyncio\ny = 1\ntry:\n    await asyncio.sleep(60)\nfinally:\n    cleaned = True');
    const neighbor = host.execute('b', 'import asyncio\nawait asyncio.sleep(0.3)\n"neighbor done"');
    await sleep(100);
    const request = await host.interrupt('a');
    assert.equal(request.interrupted.length, 1);
    const result = await slow;
    assert.equal(result.status, 'interrupted');
    assert.equal(result.error.type, 'KeyboardInterrupt');
    assert.equal((await neighbor).value, "'neighbor done'");
    assert.equal((await host.execute('a', '(x, y, cleaned)')).value, '(40, 1, True)');
    assert.deepEqual((await host.interrupt('a')).interrupted, [], 'idle session has nothing to interrupt');
  });

  await t.test('bindings are explicit host objects', async () => {
    host.bind('a', 'host_value', { answer: 42 });
    assert.equal((await host.execute('a', 'host_value.answer')).value, '42');
    assert.equal((await host.execute('b', '"host_value" in globals()')).value, 'False');
  });

  await t.test('dispose frees a session namespace', async () => {
    assert.equal(await host.dispose('b'), true);
    assert.equal((await host.session('b')).info, null);
    assert.deepEqual((await host.session('a')).info.names.includes('x'), true);
  });

  await t.test('capabilities do not claim a cross-thread writer', () => {
    assert.equal(host.capabilities().interrupt.running, 'unavailable-without-cross-thread-writer');
    assert.equal(host.status().invalidations.length, 0);
  });
});

test('a corrupt package fails initialization before Python code runs', { timeout: 60000 }, async () => {
  const bad = packages.map((item, index) => index === 0 ? { ...item, bytes: item.bytes.slice(0, -1) } : item);
  const host = createPythonHost({ loadRuntime: () => loadPyodide({ indexURL }), packages: bad, dynamicLibraries });
  await assert.rejects(host.ready(), /Python package hash mismatch/);
});

test('a signal written while Python is suspended is routed, not raised into the event loop', { timeout: 60000 }, async () => {
  // Same failure mode as probes/interrupt-mechanism.mjs, with the adapter's
  // SIGINT routing installed. Single thread, so a plain buffer is enough.
  const signals = new Int32Array(2);
  const host = createPythonHost({ loadRuntime: () => loadPyodide({ indexURL }), signals });
  await host.ready();
  const uncaught = [];
  const record = (error) => uncaught.push(String(error));
  process.on('uncaughtException', record);
  try {
    const run = host.execute('s', 'import asyncio\nticks = 0\nwhile True:\n    ticks += 1\n    await asyncio.sleep(0.01)');
    await sleep(100);
    signals[1] = 0;
    signals[0] = 2;
    const result = await Promise.race([run, sleep(3000).then(() => ({ status: 'still pending' }))]);
    assert.equal(result.status, 'interrupted', JSON.stringify(result));
    assert.deepEqual(uncaught, []);
    assert.equal((await host.execute('s', 'ticks > 0')).value, 'True');
  } finally { process.off('uncaughtException', record); }
});

test('a cross-thread writer raises KeyboardInterrupt in synchronous Python', { timeout: 60000 }, async () => {
  const sab = new SharedArrayBuffer(8);
  const worker = new Worker(fileURLToPath(new URL('python-host.node-worker.mjs', import.meta.url)), { workerData: { sab, indexURL } });
  const messages = [];
  const done = new Promise((resolve, reject) => {
    worker.on('message', (message) => {
      messages.push(message);
      if (message.phase === 'spinning') {
        // Target the execution that the worker reported, as a host would.
        setTimeout(() => { const signals = new Int32Array(sab); Atomics.store(signals, 1, message.execution); Atomics.store(signals, 0, 2); }, 200);
      }
      if (message.phase === 'done') resolve(message);
    });
    worker.on('error', reject);
  });
  try {
    const result = await done;
    assert.equal(result.interrupted.status, 'interrupted');
    assert.equal(result.interrupted.error.type, 'KeyboardInterrupt');
    assert.match(result.interrupted.error.traceback, /<session spin #2>/);
    assert.doesNotMatch(result.interrupted.error.traceback, /python_host\.py/);
    assert.equal(result.after.value, "('kept', True)");
    assert.equal(result.capabilities.interrupt.running, 'signal-buffer');
  } finally { await worker.terminate(); }
});
