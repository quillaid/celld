import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startCelld } from './local-celld.mjs';
const root = new URL('.', import.meta.url);
test('memory pressure retires Python state and preserves acknowledged SQL writes', { timeout: 60000 }, async t => {
  const local = await startCelld({ 'worker.py': await readFile(new URL('native-pressure.py', root), 'utf8') }, {
    main: 'worker.py', no_bundle: false, compatibility_flags: ['python_workers'],
    durable_objects: { bindings: [{ name: 'COUNTER', class_name: 'Counter' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['Counter'] }],
  }, { CELLD_MAX_RSS_MB: '512', CELLD_PYTHON_BUILD: fileURLToPath(new URL('build-project.mjs', root)) });
  t.after(local.close);
  const evidence = { timestamp: new Date().toISOString(), ceilingMb: 512, samples: [] };
  t.after(async () => {
    evidence.logs = local.logs();
    await mkdir(new URL('results/', root), { recursive: true });
    await writeFile(new URL('results/native-pressure.json', root), JSON.stringify(evidence, null, 2) + '\n');
  });
  const address = local.logs().match(/celld internal listening on (127\.0\.0\.1:\d+)/)?.[1];
  assert.ok(address);
  const state = async () => {
    const response = await fetch('http://' + address + '/state', { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    const result = await response.json(); evidence.samples.push(result); return result;
  };
  async function call(command) {
    const response = await fetch(local.url, { method: 'POST', body: command, signal: AbortSignal.timeout(10000) });
    const body = await response.text(); assert.equal(response.status, 200, body); return JSON.parse(body);
  }
  evidence.warm = await call('read');
  evidence.before = await state();
  assert.ok(evidence.before.in_use_bytes < 512 * 1024 * 1024, 'fixture begins below the configured pressure threshold');
  evidence.allocated = await call('allocate');
  assert.equal(evidence.allocated.count, 1);
  assert.equal(evidence.allocated.allocated, 256 * 1024 * 1024);
  const deadline = Date.now() + 15000;
  while (true) {
    const current = await state();
    if (!Object.hasOwn(current.deployment.cells, evidence.warm.scope)) break;
    assert.ok(Date.now() < deadline, 'pressure policy must retire the resident object');
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  evidence.evictedAt = Date.now();
  assert.ok(evidence.samples.some(sample => sample.shedding === 'memory'), 'memory pressure, not an unrelated eviction, must be observed');
  // RuntimeManager's normal empty-pool maintenance interval is 30 seconds.
  // Observe release separately from the strict HTTP recovery deadline.
  const releaseDeadline = Date.now() + 40000;
  while (true) {
    const current = await state();
    const pools = Object.values(current.deployment.isolates.cells);
    if (pools.some(pool => pool.freed > 0) && current.shedding === null) break;
    assert.ok(Date.now() < releaseDeadline, 'empty Python heap must be freed and pressure must clear after maintenance');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  evidence.releasedAt = Date.now();
  assert.ok(evidence.samples.at(-1).in_use_bytes < 512 * 1024 * 1024);
  try { evidence.after = await call('read'); }
  catch (error) { evidence.recoveryFailure = String(error); await state(); throw error; }
  assert.notEqual(evidence.after.instance, evidence.allocated.instance);
  assert.equal(evidence.after.count, 1);
  assert.equal(evidence.after.allocated, 0);
});
