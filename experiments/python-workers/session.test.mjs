// python-host sessions inside real celld Durable Objects. Runs against
// CELLD_BIN (defaults to the task-local v0.6.0 release binary).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCelld } from './local-celld.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function files() {
  const out = { 'index.js': await readFile(resolve(root, 'dist/session.js'), 'utf8') };
  for (const name of await readdir(resolve(root, 'dist'))) {
    if (name.endsWith('.wasm')) out[name] = await readFile(resolve(root, 'dist', name));
  }
  return out;
}

test('python-host sessions in celld Durable Objects', { timeout: 180000 }, async (t) => {
  const local = await startCelld(await files(), {
    durable_objects: { bindings: [{ name: 'SESSIONS', class_name: 'PythonSession' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['PythonSession'] }],
  });
  t.after(local.close);
  const evidence = { timestamp: new Date().toISOString(), celld: process.env.CELLD_BIN || 'task-local release', calls: [] };
  t.after(async () => {
    await mkdir(resolve(root, 'results'), { recursive: true });
    await writeFile(resolve(root, 'results/session.json'), JSON.stringify(evidence, null, 2) + '\n');
  });
  async function call(path, body, { timeout = 20000 } = {}) {
    const started = Date.now();
    const response = await fetch(local.url + path, { method: body === undefined ? 'GET' : 'POST', body, signal: AbortSignal.timeout(timeout) });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    const record = { path, body, httpStatus: response.status, elapsedMs: Date.now() - started, json, text: json ? undefined : text.slice(0, 2000) };
    evidence.calls.push(record);
    return record;
  }
  const exec = (name, code, options) => call(`/s/${name}/execute`, code, options);

  let isolate;
  await t.test('concurrent first executions share one interpreter initialization', async () => {
    const [a, b] = await Promise.all([exec('a', 'x = 1\nx'), exec('b', 'x = 2\nx')]);
    for (const [result, value] of [[a, '1'], [b, '2']]) {
      assert.equal(result.httpStatus, 200, JSON.stringify(result));
      assert.equal(result.json.status, 'ok');
      assert.equal(result.json.value, value);
      assert.equal(result.json.generation, 1);
    }
    assert.equal(a.json.isolate, b.json.isolate, 'both objects must share the isolate for the shared-interpreter checks');
    isolate = a.json.isolate;
    const readies = local.logs().split('\n').filter((line) => line.includes('"python_ready"') && line.includes(isolate));
    assert.equal(readies.length, 1, readies.join('\n'));
  });

  await t.test('each Durable Object keeps its own namespace across requests', async () => {
    assert.equal((await exec('a', 'x += 10\nprint("a says", x)\nx')).json.value, '11');
    const b = await exec('b', 'x');
    assert.equal(b.json.value, '2');
    const out = evidence.calls.at(-2).json;
    assert.equal(out.stdout, 'a says 11\n');
  });

  await t.test('a Python error is a structured result and the namespace stays usable', async () => {
    const error = await exec('a', 'import json\njson.loads("{bad")');
    assert.equal(error.httpStatus, 200);
    assert.equal(error.json.status, 'error');
    assert.equal(error.json.error.type, 'JSONDecodeError');
    assert.match(error.json.error.traceback, /<session .* #3>/);
    assert.equal((await exec('a', 'x')).json.value, '11');
  });

  await t.test('locked pure and compiled packages import from bundled bytes', async () => {
    const result = await exec('a', 'import humanize, markupsafe._speedups as s\n(humanize.naturalsize(123456789), s.__file__.endswith(".so"), str(s._escape_inner("<&>")))');
    assert.equal(result.json.status, 'ok', JSON.stringify(result.json));
    assert.equal(result.json.value, "('123.5 MB', True, '&lt;&amp;&gt;')");
  });

  await t.test('a stateless Worker session runs in the same adapter', async () => {
    const result = await call('/w/execute', 'import sys\nsys.platform');
    assert.equal(result.json.value, "'emscripten'");
  });

  await t.test('storage bindings are durable, namespaces are not', async () => {
    const result = await exec('a', [
      'ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS t (v INTEGER)")',
      'ctx.storage.sql.exec("INSERT INTO t VALUES (7)")',
      'kept = "in memory only"',
      'ctx.storage.sql.exec("SELECT count(*) AS n FROM t").one().n',
    ].join('\n'));
    assert.equal(result.json.value, '1', JSON.stringify(result.json));
  });

  await t.test('interrupting a suspended execution reports KeyboardInterrupt and keeps the namespace', async () => {
    const pending = exec('a', 'import asyncio\nstep = "started"\nawait asyncio.sleep(60)\nstep = "finished"');
    await sleep(300);
    const request = await call('/s/a/interrupt', '');
    assert.equal(request.json.interrupted.length, 1, JSON.stringify(request.json));
    const result = await pending;
    assert.equal(result.json.status, 'interrupted');
    assert.equal(result.json.error.type, 'KeyboardInterrupt');
    assert.ok(result.elapsedMs < 5000, `interrupt took ${result.elapsedMs}ms`);
    assert.equal((await exec('a', '(x, step, kept)')).json.value, "(11, 'started', 'in memory only')");
  });

  await t.test('forced eviction ends the namespace; storage survives', async () => {
    const info = await call('/s/a/info');
    const objectId = info.json.session.split(':')[0];
    const address = local.logs().match(/celld internal listening on (127\.0\.0\.1:\d+)/)?.[1];
    assert.ok(address, 'internal listener address');
    const evicted = await fetch(`http://${address}/evict/PythonSession:${objectId}`, { method: 'POST', signal: AbortSignal.timeout(10000) });
    evidence.eviction = { status: evicted.status, body: await evicted.text() };
    assert.equal(evicted.status, 200, evidence.eviction.body);
    const after = await exec('a', 'ctx.storage.sql.exec("SELECT v FROM t").one().v');
    assert.equal(after.json.value, '7');
    assert.notEqual(after.json.objectInstance, info.json.objectInstance);
    const gone = await exec('a', 'x');
    assert.equal(gone.json.error?.type, 'NameError');
    const later = await call('/s/a/info');
    evidence.afterEviction = { sameIsolate: later.json.isolate === isolate, previousSession: later.json.previousSession, previousInfo: later.json.previousInfo };
    if (later.json.isolate === isolate) {
      assert.equal(later.json.previousSession.existed, true, 'the old namespace was still present and is now disposed');
      assert.equal(later.json.previousInfo, null);
    }
  });

  await t.test('synchronous Python: cross-thread KeyboardInterrupt when the host provides it', async () => {
    const info = await call('/s/a/info');
    const capability = info.json.capabilities.interrupt.running;
    evidence.syncInterrupt = { capability, crossThread: info.json.crossThread };
    const address = local.logs().match(/celld internal listening on (127\.0\.0\.1:\d+)/)?.[1];
    const scope = `PythonSession:${info.json.session.split(':')[0]}`;
    const signal = async () => {
      const response = await fetch(`http://${address}/python/interrupt/${scope}`, { method: 'POST', signal: AbortSignal.timeout(5000) });
      return { status: response.status, body: await response.text() };
    };
    if (!info.json.crossThread) {
      // Stock v0.6.0 has no writer. The adapter must say so, not pretend.
      assert.equal(capability, 'unavailable-without-cross-thread-writer');
      evidence.syncInterrupt.internalRoute = await signal();
      return;
    }
    assert.equal(capability, 'signal-buffer');
    assert.deepEqual(await signal().then((r) => [r.status, JSON.parse(r.body)]), [200, { outcome: 'idle' }]);
    assert.equal((await exec('a', 'spin_marker = "kept"\nspin_marker')).json.value, "'kept'");
    const spinning = exec('a', 'n = 0\nwhile True:\n    n += 1', { timeout: 30000 });
    await sleep(500);
    // The isolate thread is busy: an in-isolate interrupt request cannot run.
    const blocked = await call('/s/a/interrupt', '', { timeout: 1000 }).then(() => 'answered', (error) => error.name);
    evidence.syncInterrupt.inIsolateRequestWhileSpinning = blocked;
    const signalledAt = Date.now();
    const signalled = await signal();
    evidence.syncInterrupt.signal = signalled;
    assert.equal(signalled.status, 200, signalled.body);
    assert.equal(JSON.parse(signalled.body).outcome, 'signalled');
    const result = await spinning;
    evidence.syncInterrupt.result = result.json;
    evidence.syncInterrupt.signalToResultMs = Date.now() - signalledAt;
    assert.equal(result.json.status, 'interrupted', JSON.stringify(result.json));
    assert.equal(result.json.error.type, 'KeyboardInterrupt');
    assert.match(result.json.error.traceback, /#\d+>", line [23], in <module>/);
    assert.doesNotMatch(result.json.error.traceback, /python_host\.py/);
    assert.equal(result.json.execution, JSON.parse(signalled.body).execution);
    const after = await exec('a', '(spin_marker, n > 0)');
    assert.equal(after.json.value, "('kept', True)", JSON.stringify(after.json));
    assert.equal(after.json.generation, 1, 'cooperative interrupt keeps the interpreter');
    assert.deepEqual(JSON.parse((await signal()).body), { outcome: 'idle' });
    const unknown = await fetch(`http://${address}/python/interrupt/PythonSession:missing`, { method: 'POST', signal: AbortSignal.timeout(5000) });
    assert.equal(unknown.status, 404);
  });

  await t.test('awaited async entries and the Emscripten stack under this host', async () => {
    const result = await call('/probe/async-entries?n=2000');
    evidence.asyncEntries = result.json;
    assert.equal(result.httpStatus, 200, result.text);
    // Pyodide 0.28.3 under JSPI loses 48 bytes per awaited entry. The bundle
    // hides JSPI from Pyodide, so the depth must stay flat here.
    const depths = result.json.depthBelowBase.map(([, depth]) => depth);
    assert.equal(result.json.stackSwitching, false);
    assert.ok(depths.every((depth) => depth === depths[0]), JSON.stringify(result.json));
    const info = await call('/s/a/info');
    assert.equal(info.json.capabilities.stackSwitching, false);
    evidence.hostJspi = info.json.capabilities.host.jspi;
  });

  await t.test('destructive termination from Python invalidates the interpreter; later calls get a new one', async () => {
    assert.equal((await exec('b', 'bvar = 3\nbvar')).json.value, '3');
    const suspended = exec('b', 'import asyncio\nawait asyncio.sleep(60)');
    await sleep(300);
    const aborted = await exec('a', 'ctx.abort("python-host test: destructive termination")\n"unreachable"');
    evidence.abort = aborted;
    assert.equal(aborted.httpStatus, 500, JSON.stringify(aborted));
    const sibling = await suspended;
    assert.equal(sibling.json.status, 'invalidated', JSON.stringify(sibling.json));
    assert.ok(sibling.elapsedMs < 5000, `suspended sibling settled after ${sibling.elapsedMs}ms`);
    const fresh = await exec('a', '1 + 1');
    assert.equal(fresh.json.status, 'ok', JSON.stringify(fresh.json));
    assert.equal(fresh.json.generation, 2);
    const lost = await exec('b', 'bvar');
    assert.equal(lost.json.generation, 2);
    assert.equal(lost.json.error?.type, 'NameError', 'a new interpreter starts with empty namespaces');
    const packagesAgain = await exec('b', 'import humanize\nhumanize.intcomma(1000)');
    assert.equal(packagesAgain.json.value, "'1,000'");
    const status = (await call('/s/b/info')).json.status;
    evidence.status = status;
    assert.equal(status.invalidations.length, 1);
    assert.match(status.invalidations[0].reason, /Python entry did not return/);
  });
});
