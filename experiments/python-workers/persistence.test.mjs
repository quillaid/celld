import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCelld } from './local-celld.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
test('Python SQL rollback, alarms, and acknowledged state survive process crash', { timeout: 90000 }, async (t) => {
  const local = await startCelld({
    'index.js': await readFile(resolve(root, 'dist/index.js'), 'utf8'),
    'pyodide.asm.wasm': await readFile(resolve(root, 'dist/pyodide.asm.wasm')),
    'sentinel.wasm': await readFile(resolve(root, 'dist/sentinel.wasm')),
  }, {
    compatibility_flags: ['python_workers'],
    durable_objects: { bindings: [{ name: 'PYTHON_COUNTER', class_name: 'PythonCounter' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['PythonCounter'] }],
  });
  t.after(local.close);
  const evidence = { timestamp: new Date().toISOString(), storage: 'celld dev persistent local object store', responses: [] };
  t.after(async () => {
    await mkdir(resolve(root, 'results'), { recursive: true });
    await writeFile(resolve(root, 'results/persistence.json'), JSON.stringify(evidence, null, 2) + '\n');
  });
  async function call(operation, headers) {
    const response = await fetch(`${local.url}/do/persistent/${operation}`, { headers, signal: AbortSignal.timeout(10000) });
    const text = await response.text();
    const result = { operation, status: response.status, text, interpreter: response.headers.get('x-python-instance-id') };
    evidence.responses.push(result);
    return result;
  }
  const first = await call('inc');
  assert.equal(first.status, 200, first.text);
  assert.equal(JSON.parse(first.text).value, 1);
  const rolledBack = await call('rollback');
  assert.equal(rolledBack.status, 500, rolledBack.text);
  assert.match(rolledBack.text, /intentional transaction rollback/);
  const unchanged = await call('read');
  assert.equal(unchanged.status, 200, unchanged.text);
  assert.equal(JSON.parse(unchanged.text).value, 1);
  const increments = await Promise.all(Array.from({ length: 10 }, () => call('inc')));
  assert.ok(increments.every((result) => result.status === 200), JSON.stringify(increments));
  assert.deepEqual(increments.map((result) => JSON.parse(result.text).value).sort((a, b) => a - b), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  async function waitForFires(expected) {
    const deadline = Date.now() + 15000;
    let result;
    do {
      result = await call('read');
      assert.equal(result.status, 200, result.text);
      if (JSON.parse(result.text).fires === expected) return result;
      await new Promise((done) => setTimeout(done, 100));
    } while (Date.now() < deadline);
    assert.fail(`Alarm did not reach ${expected} fires: ${JSON.stringify(result)}`);
  }
  const arm = await call('arm');
  assert.equal(arm.status, 200, arm.text);
  const fired = await waitForFires(1);
  assert.equal(JSON.parse(fired.text).value, 11);
  const pending = await call('arm', { 'x-alarm-delay': '5000' });
  assert.equal(pending.status, 200, pending.text);
  assert.ok(JSON.parse(pending.text).alarmAt > Date.now());
  evidence.preCrashPid = local.pid;
  // Kill only the test supervisor and its descendants after writes and alarm arms
  // were acknowledged; reuse exactly its existing dev storage on restart.
  evidence.restart = await local.restart({ crash: true });
  evidence.postCrashPid = local.pid;
  assert.notEqual(local.pid, evidence.preCrashPid);
  const restored = await call('read');
  assert.equal(restored.status, 200, restored.text);
  assert.equal(JSON.parse(restored.text).value, 11);
  assert.notEqual(restored.interpreter, first.interpreter);
  assert.notEqual(JSON.parse(restored.text).objectInstance, JSON.parse(first.text).objectInstance);
  const afterAlarm = await waitForFires(2);
  assert.equal(JSON.parse(afterAlarm.text).value, 11);
});
