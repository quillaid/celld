import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import WebSocket from 'ws';
import { startCelld } from './local-celld.mjs';
const root = new URL('.', import.meta.url);
export function registerSocketLifecycleTest({ idle = false } = {}) {
  test(idle ? 'Python live sockets hibernate through the automatic idle policy' : 'Python Durable Object reconstructs around a live socket after forced eviction', { timeout: 60000 }, async t => {
    const local = await startCelld({ 'worker.py': await readFile(new URL('socket-eviction.py', root), 'utf8') }, {
      main: 'worker.py', no_bundle: false, compatibility_flags: ['python_workers'],
      durable_objects: { bindings: [{ name: 'COUNTER', class_name: 'Counter' }] },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['Counter'] }],
    }, { ...(idle ? { CELLD_IDLE_EVICT_S: '1' } : {}), CELLD_PYTHON_BUILD: fileURLToPath(new URL('build-project.mjs', root)) });
    t.after(local.close);
    const evidence = { timestamp: new Date().toISOString(), messages: [], evictions: [], residency: [], idleKeepaliveReplies: 0 };
    t.after(async () => {
      evidence.logs = local.logs();
      await mkdir(new URL('results/', root), { recursive: true });
      await writeFile(new URL(idle ? 'results/socket-idle.json' : 'results/socket-eviction.json', root), JSON.stringify(evidence, null, 2) + '\n');
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
    assert.equal(previous.auto_timestamp, null);
    const otherInitial = await send('second-before', second, 'second');
    assert.equal(otherInitial.count, 2);
    assert.equal(otherInitial.auto_timestamp, null);
    const address = local.logs().match(/celld internal listening on (127\.0\.0\.1:\d+)/)?.[1];
    assert.ok(address, 'test-owned internal listener is reported');
    async function residency(scope, expected, phase) {
      const response = await fetch('http://' + address + '/state', { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      const state = await response.json();
      assert.ok(state.deployment?.cells, 'resident generation census exists');
      const resident = Object.hasOwn(state.deployment.cells, scope);
      evidence.residency.push({ phase, resident, cells: state.deployment.cells });
      assert.equal(resident, expected, phase);
    }
    async function evict(scope) {
      if (idle) {
        const started = Date.now();
        const deadline = started + 10000;
        while (true) {
          // Matching keepalives must not keep the Python object resident.
          const reply = once(second, 'message', { signal: AbortSignal.timeout(5000) });
          second.send('ping');
          assert.equal((await reply)[0].toString(), 'pong');
          evidence.idleKeepaliveReplies++;
          const response = await fetch('http://' + address + '/state', { signal: AbortSignal.timeout(5000) });
          assert.equal(response.status, 200);
          const state = await response.json();
          assert.ok(state.deployment?.cells);
          if (!Object.hasOwn(state.deployment.cells, scope)) {
            evidence.evictions.push({ automatic: true, waitedMs: Date.now() - started, cells: state.deployment.cells });
            return;
          }
          assert.ok(Date.now() < deadline, 'idle policy must evict the Python Durable Object within the observation deadline');
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }

      const response = await fetch('http://' + address + '/evict/' + scope, { method: 'POST', signal: AbortSignal.timeout(10000) });
      const body = await response.text();
      evidence.evictions.push({ status: response.status, body });
      assert.equal(response.status, 200, body);
    }
    for (let cycle = 1; cycle <= 3; cycle++) {
      await residency(previous.scope, true, 'before eviction ' + cycle);
      await evict(previous.scope);
      await residency(previous.scope, false, 'after eviction ' + cycle);
      const pingStarted = Date.now();
      for (const connection of [socket, second]) {
        const reply = once(connection, 'message', { signal: AbortSignal.timeout(5000) });
        connection.send('ping');
        assert.equal((await reply)[0].toString(), 'pong');
        await residency(previous.scope, false, 'after auto-response ' + cycle);
      }
      assert.equal(socket.readyState, WebSocket.OPEN);
      const next = await send('after-' + cycle);
      assert.ok(next.auto_timestamp >= pingStarted && next.auto_timestamp <= Date.now());
      assert.notEqual(next.instance, previous.instance, 'new Python Durable Object instance required');
      assert.equal(next.restored, 2);
      assert.equal(next.count, cycle * 2 + 1);
      assert.equal(next.scope, previous.scope);
      const other = await send('second-after-' + cycle, second, 'second');
      assert.equal(other.instance, next.instance);
      assert.equal(other.count, cycle * 2 + 2);
      assert.ok(other.auto_timestamp >= pingStarted && other.auto_timestamp <= Date.now());
      await residency(previous.scope, true, 'after application wake ' + cycle);
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
}
