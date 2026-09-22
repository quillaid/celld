import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import workerd from 'workerd';
import WebSocket from 'ws';
import { startCelld } from './local-celld.mjs';
const root = new URL('.', import.meta.url);
test('native Python Durable Object WebSocket events match workerd', { timeout: 60000 }, async (t) => {
  const source = await readFile(new URL('native-websocket.py', root), 'utf8');
  const local = await startCelld({ 'worker.py': source }, {
    main: 'worker.py', no_bundle: false, compatibility_flags: ['python_workers'],
    durable_objects: { bindings: [{ name: 'COUNTER', class_name: 'Counter' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['Counter'] }],
  }, { CELLD_PYTHON_BUILD: fileURLToPath(new URL('build-project.mjs', root)) });
  t.after(local.close);
  const previous = process.env.MINIFLARE_WORKERD_PATH;
  process.env.MINIFLARE_WORKERD_PATH = workerd.default;
  t.after(() => { if (previous === undefined) delete process.env.MINIFLARE_WORKERD_PATH; else process.env.MINIFLARE_WORKERD_PATH = previous; });
  const wheel = fileURLToPath(new URL('.celld/workers_runtime_sdk-1.9.0-py3-none-any.whl', root));
  const names = execFileSync('unzip', ['-Z1', wheel], { encoding: 'utf8' }).trim().split('\n');
  const modules = names.filter(name => name.startsWith('workers/') && name.endsWith('.py')).map(name => ({ type: 'Data', path: resolve(fileURLToPath(root), 'python_modules', name), contents: execFileSync('unzip', ['-p', wheel, name]) }));
  const reference = new Miniflare(convertV4MiniflareOptions({
    name: 'native-websocket-reference', cf: false, modulesRoot: fileURLToPath(root),
    compatibilityDate: '2025-06-01', compatibilityFlags: ['python_workers', 'python_workers_20250116'],
    modules: [{ type: 'PythonModule', path: fileURLToPath(new URL('native-websocket-reference.py', root)), contents: "import sys\nsys.path.insert(0, '/session/metadata/python_modules')\n" + source + '\nDefault.on_fetch = Default.fetch\nCounter.on_fetch = Counter.fetch\nCounter.on_webSocketMessage = Counter.webSocketMessage\nCounter.on_webSocketClose = Counter.webSocketClose\n' }, ...modules],
    durableObjects: { COUNTER: { className: 'Counter', useSQLite: true } },
  }));
  t.after(() => reference.dispose());
  const evidence = { timestamp: new Date().toISOString(), workerd: workerd.version, referenceDate: '2025-06-01', responses: [] };
  t.after(async () => {
    evidence.logs = local.logs();
    await mkdir(new URL('results/', root), { recursive: true });
    await writeFile(new URL('results/native-websocket.json', root), JSON.stringify(evidence, null, 2) + '\n');
  });

  async function observe(url, label) {
    const socket = new WebSocket(url.replace(/^http/, 'ws'));
    socket.binaryType = 'arraybuffer';
    socket.on('unexpected-response', (_request, response) => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => { evidence.upgradeFailure = { status: response.statusCode, body }; socket.emit('error', new Error(body)); });
    });
    t.after(() => socket.close());
    const event = (type) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(label + ' ' + type + ' timeout')); }, 10000);
      const done = value => { cleanup(); resolve(value); };
      const fail = () => { cleanup(); reject(new Error(label + ' socket error')); };
      function cleanup() { clearTimeout(timer); socket.removeEventListener(type, done); socket.removeEventListener('error', fail); }
      socket.addEventListener(type, done, { once: true });
      socket.addEventListener('error', fail, { once: true });
    });
    await event('open');
    const results = [];
    evidence[label + 'Messages'] = results;
    for (const value of ['hello Python 🐍', new Uint8Array([0, 1, 127, 128, 255])]) {
      const received = event('message');
      socket.send(value);
      results.push(JSON.parse((await received).data));
    }
    const closed = event('close');
    socket.close(1000, 'finished');
    const close = await closed;
    const response = await fetch(url);
    assert.equal(response.status, 200);
    return { results, close: { code: close.code, reason: close.reason, clean: close.wasClean }, stored: await response.json() };
  }
  const referenceUrl = (await reference.ready).href;
  evidence.reference = await observe(referenceUrl, 'workerd');
  try { evidence.local = await observe(local.url, 'celld'); }
  catch (error) {
    evidence.afterFailure = await (await fetch(local.url)).text();
    throw error;
  }
  assert.deepEqual(evidence.local, evidence.reference);
  assert.deepEqual(evidence.local.results, [
    { value: 'hello Python 🐍', attachment: 'python-session' },
    { value: [0, 1, 127, 128, 255], attachment: 'python-session' },
  ]);
  assert.equal(evidence.local.stored.length, 3);
  evidence.restart = await local.restart({ crash: true });
  evidence.afterRestart = await (await fetch(local.url)).json();
  assert.deepEqual(evidence.afterRestart, evidence.local.stored);
});
