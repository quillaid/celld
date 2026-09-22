import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import workerd from 'workerd';
import { startCelld } from './local-celld.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const source = `
export class Counter {
  constructor(ctx) { this.storage = ctx.storage; }
  fetch() {
    const storage = this.storage;
    storage.sql.exec('CREATE TABLE IF NOT EXISTS probe (value INTEGER)');
    let argumentsSeen;
    const value = storage.transactionSync(function() {
      argumentsSeen = arguments.length;
      storage.sql.exec('INSERT INTO probe VALUES (1)');
      try { storage.transactionSync(() => { storage.sql.exec('INSERT INTO probe VALUES (2)'); throw new Error('rollback'); }); }
      catch (error) { if (error.message !== 'rollback') throw error; }
      return 42;
    });
    return Response.json({ argumentsSeen, value, rows: storage.sql.exec('SELECT value FROM probe').toArray() });
  }
}
export default { fetch(request, env) { return env.COUNTER.getByName('probe').fetch(request); } };
`;
test('transactionSync callback and nested rollback match pinned workerd', { timeout: 30000 }, async (t) => {
  const local = await startCelld({ 'index.js': source }, {
    durable_objects: { bindings: [{ name: 'COUNTER', class_name: 'Counter' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['Counter'] }],
  });
  t.after(local.close);
  const previous = process.env.MINIFLARE_WORKERD_PATH;
  process.env.MINIFLARE_WORKERD_PATH = workerd.default;
  t.after(() => {
    if (previous === undefined) delete process.env.MINIFLARE_WORKERD_PATH;
    else process.env.MINIFLARE_WORKERD_PATH = previous;
  });
  const reference = new Miniflare(convertV4MiniflareOptions({
    name: 'transaction-contract', cf: false, compatibilityDate: '2026-09-21',
    modules: true, script: source,
    durableObjects: { COUNTER: { className: 'Counter', useSQLite: true } },
  }));
  t.after(() => reference.dispose());
  const actual = await fetch(local.url, { signal: AbortSignal.timeout(5000) });
  const expected = await reference.dispatchFetch('http://local/');
  const raw = { timestamp: new Date().toISOString(), workerd: workerd.version,
    celld: { status: actual.status, text: await actual.clone().text() },
    reference: { status: expected.status, text: await expected.clone().text() } };
  await mkdir(resolve(root, 'results'), { recursive: true });
  await writeFile(resolve(root, 'results/transaction-contract-raw.json'), JSON.stringify(raw, null, 2) + '\n');
  assert.equal(actual.status, 200, raw.celld.text);
  assert.equal(expected.status, 200, raw.reference.text);
  const evidence = { timestamp: new Date().toISOString(), workerd: workerd.version, celld: await actual.json(), reference: await expected.json() };
  await mkdir(resolve(root, 'results'), { recursive: true });
  await writeFile(resolve(root, 'results/transaction-contract.json'), JSON.stringify(evidence, null, 2) + '\n');
  assert.deepEqual(evidence.reference, { argumentsSeen: 0, value: 42, rows: [{ value: 1 }] });
  assert.deepEqual(evidence.celld, evidence.reference);
});
