import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import WebSocket from 'ws';
import { startCelld } from './local-celld.mjs';
const root = new URL('.', import.meta.url);
test('Python Durable Object reconstructs around a live socket after forced eviction', { timeout: 60000 }, async t => {
  const local = await startCelld({ 'worker.py': await readFile(new URL('socket-eviction.py', root), 'utf8') }, {
    main: 'worker.py', no_bundle: false, compatibility_flags: ['python_workers'],
    durable_objects: { bindings: [{ name: 'COUNTER', class_name: 'Counter' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['Counter'] }],
  }, { CELLD_PYTHON_BUILD: fileURLToPath(new URL('build-project.mjs', root)) });
  t.after(local.close);
  const evidence = { timestamp: new Date().toISOString(), messages: [], evictions: [] };
  t.after(async () => {
    evidence.logs = local.logs();
    await mkdir(new URL('results/', root), { recursive: true });
    await writeFile(new URL('results/socket-eviction.json', root), JSON.stringify(evidence, null, 2) + '\n');
  });
  const socket = new WebSocket(local.url.replace(/^http/, 'ws') + '/first');
  t.after(() => socket.terminate());
  await once(socket, 'open', { signal: AbortSignal.timeout(10000) });
  const second = new WebSocket(local.url.replace(/^http/, 'ws') + '/second');
  t.after(() => second.terminate());
  await once(second, 'open', { signal: AbortSignal.timeout(10000) });
  async function send(message, connection = socket, attachment = 'first') {
    const received = once(connection, 'message', { signal: AbortSignal.timeout(10000) });
    connection.send(message);
    const result = JSON.parse((await received)[0].toString());
    evidence.messages.push(result);
    assert.equal(result.message, message);
    assert.equal(result.attachment, attachment);
    assert.deepEqual(result.tags, ['python']);
    return result;
  }
  let previous = await send('before');
  assert.equal(previous.count, 1);
  assert.equal(previous.restored, 0);
  assert.equal((await send('second-before', second, 'second')).count, 2);
  const address = local.logs().match(/celld internal listening on (127\.0\.0\.1:\d+)/)?.[1];
  assert.ok(address, 'test-owned internal listener is reported');
  async function evict(scope) {
    const response = await fetch('http://' + address + '/evict/' + scope, { method: 'POST', signal: AbortSignal.timeout(10000) });
    const body = await response.text();
    evidence.evictions.push({ status: response.status, body });
    assert.equal(response.status, 200, body);
  }
  for (let cycle = 1; cycle <= 3; cycle++) {
    await evict(previous.scope);
    assert.equal(socket.readyState, WebSocket.OPEN);
    const next = await send('after-' + cycle);
    assert.notEqual(next.instance, previous.instance, 'new Python Durable Object instance required');
    assert.equal(next.restored, 2);
    assert.equal(next.count, cycle * 2 + 1);
    assert.equal(next.scope, previous.scope);
    const other = await send('second-after-' + cycle, second, 'second');
    assert.equal(other.instance, next.instance);
    assert.equal(other.count, cycle * 2 + 2);
    previous = next;
  }
  const closed = once(socket, 'close', { signal: AbortSignal.timeout(10000) });
  socket.close(1000, 'done');
  assert.equal((await closed)[0], 1000);
  await evict(previous.scope);
  const survivor = await send('survivor', second, 'second');
  assert.notEqual(survivor.instance, previous.instance);
  assert.equal(survivor.restored, 1);
  assert.equal(survivor.count, 9);
  const finalClose = once(second, 'close', { signal: AbortSignal.timeout(10000) });
  second.close(1000, 'done');
  assert.equal((await finalClose)[0], 1000);
});
