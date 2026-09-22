import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startCelld } from './local-celld.mjs';
const root = new URL('.', import.meta.url);
test('stopping one Python object preserves its shared heap until the last object stops', { timeout: 60000 }, async t => {
  const local = await startCelld({ 'worker.py': await readFile(new URL('native-pressure.py', root), 'utf8') }, {
    main: 'worker.py', no_bundle: false, compatibility_flags: ['python_workers'],
    durable_objects: { bindings: [{ name: 'COUNTER', class_name: 'Counter' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['Counter'] }],
  }, { CELLD_MAX_RSS_MB: '0', CELLD_PYTHON_BUILD: fileURLToPath(new URL('build-project.mjs', root)) });
  t.after(local.close);
  const evidence = { timestamp: new Date().toISOString(), pools: [] };
  t.after(async () => {
    await mkdir(new URL('results/', root), { recursive: true });
    await writeFile(new URL('results/shared-heap.json', root), JSON.stringify(evidence, null, 2) + '\n');
  });
  const address = local.logs().match(/celld internal listening on (127\.0\.0\.1:\d+)/)?.[1];
  assert.ok(address);
  async function read(name) {
    const response = await fetch(local.url + '/' + name, { signal: AbortSignal.timeout(10000) });
    const body = await response.text(); assert.equal(response.status, 200, body); return JSON.parse(body);
  }
  async function pool() {
    const response = await fetch('http://' + address + '/state');
    assert.equal(response.status, 200);
    const result = (await response.json()).deployment.isolates.cells['python-runtime-probe'];
    evidence.pools.push(result); return result;
  }
  async function evict(scope) {
    const response = await fetch('http://' + address + '/evict/' + scope, { method: 'POST', signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200, await response.text());
  }
  evidence.first = await read('first');
  evidence.second = await read('second');
  let census = await pool();
  assert.equal(census.cells, 2);
  assert.equal(census.live, 1, 'both objects must share a single interpreter heap');
  await evict(evidence.first.scope);
  census = await pool();
  assert.equal(census.cells, 1);
  assert.equal(census.live, 1);
  assert.equal(census.freed, 0);
  evidence.survivor = await read('second');
  assert.equal(evidence.survivor.instance, evidence.second.instance);
  await evict(evidence.second.scope);
  census = await pool();
  assert.equal(census.cells, 0);
  assert.equal(census.live, 0);
  assert.equal(census.freed, 1);
});
