import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import workerd from 'workerd';
import { startCelld } from './local-celld.mjs';
const root = new URL('.', import.meta.url);
test('released Workers SDK HTTP, streaming, and background work match workerd', { timeout: 30000 }, async (t) => {
  const local = await startCelld({
    'index.js': await readFile(new URL('dist/sdk.js', root)),
    'pyodide.asm.wasm': await readFile(new URL('dist/pyodide.asm.wasm', root)),
    'sentinel.wasm': await readFile(new URL('dist/sentinel.wasm', root)),
  }, { compatibility_flags: ['python_workers'], kv_namespaces: [{ binding: 'CACHE', id: 'sdk-cache' }] });
  t.after(local.close);
  const previous = process.env.MINIFLARE_WORKERD_PATH;
  process.env.MINIFLARE_WORKERD_PATH = workerd.default;
  t.after(() => {
    if (previous === undefined) delete process.env.MINIFLARE_WORKERD_PATH;
    else process.env.MINIFLARE_WORKERD_PATH = previous;
  });
  const wheel = fileURLToPath(new URL('.celld/workers_runtime_sdk-1.9.0-py3-none-any.whl', root));
  const entries = execFileSync('unzip', ['-Z1', wheel], { encoding: 'utf8' }).trim().split('\n');
  const modules = entries.filter(name => name.startsWith('workers/') && name.endsWith('.py')).map(name => ({
    type: 'Data', path: resolve(fileURLToPath(root), 'python_modules', name), contents: execFileSync('unzip', ['-p', wheel, name]),
  }));
  const expectedSdkDigest = createHash('sha256').update(execFileSync('unzip', ['-p', wheel, 'workers/entrypoints.py'])).digest('hex');
  const source = await readFile(new URL('sdk-worker.py', root), 'utf8');
  const reference = new Miniflare(convertV4MiniflareOptions({
    name: 'sdk-reference', cf: false, modulesRoot: fileURLToPath(root),
    compatibilityDate: '2025-06-01', compatibilityFlags: ['python_workers', 'python_workers_20250116'],
    modules: [{ type: 'PythonModule', path: fileURLToPath(new URL('sdk-reference.py', root)),
      contents: "import sys\nsys.path.insert(0, '/session/metadata/python_modules')\n" + source + '\nDefault.on_fetch = Default.fetch\n' }, ...modules],
    kvNamespaces: ['CACHE'],
  }));
  t.after(() => reference.dispose());
  const evidence = { timestamp: new Date().toISOString(), reference: { workerd: workerd.version, compatibilityDate: '2025-06-01', adapter: 'Default.on_fetch alias for historical runtime dispatch; unchanged SDK wheel and Python source' }, sdk: JSON.parse(await readFile(new URL('sdk-lock.json', root))), responses: [], phases: [] };
  t.after(async () => {
    await mkdir(new URL('results/', root), { recursive: true });
    await writeFile(new URL('results/sdk.json', root), JSON.stringify(evidence, null, 2) + '\n');
  });
  async function call(body, compare = true) {
    const phase = stage => evidence.phases.push({ input: body, stage, timestamp: new Date().toISOString() });
    phase('celld-request');
    const response = await fetch(local.url, { method: 'POST', body, signal: AbortSignal.timeout(10000) });
    // Consume celld's body within its deadline, before reference cold startup.
    const actualBytes = [...new Uint8Array(await response.clone().arrayBuffer())];
    phase('celld-body-complete');
    const expected = await reference.dispatchFetch('http://local/', { method: 'POST', body });
    phase('workerd-response');
    const expectedBytes = [...new Uint8Array(await expected.arrayBuffer())];
    evidence.responses.push({ input: body, celld: { status: response.status, bytes: actualBytes }, workerd: { status: expected.status, bytes: expectedBytes } });
    assert.equal(response.status, expected.status, JSON.stringify(evidence.responses.at(-1)));
    if (compare) assert.deepEqual(actualBytes, expectedBytes);
    assert.equal(response.headers.get('x-sdk'), expected.headers.get('x-sdk'));
    return new Response(new Uint8Array(actualBytes), { status: response.status, headers: response.headers });
  }
  const identity = await call('sdk-identity');
  assert.equal(identity.status, 200);
  assert.deepEqual(await identity.json(), { entrypoints_sha256: expectedSdkDigest });
  const json = await call('hello');
  assert.equal(json.status, 201, await json.clone().text());
  assert.equal(json.headers.get('x-sdk'), '1.9.0');
  assert.deepEqual(await json.json(), { body: 'hello', method: 'POST' });
  await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    const body = 'concurrent:' + index;
    const response = await call(body);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), body);
  }));
  const failure = await call('raise', false);
  assert.equal(failure.status, 500);
  const failureText = await failure.text();
  assert.match(failureText, /ValueError: SDK application exception/);
  assert.match(failureText, /\/app\/worker\.py/);
  const expectedFailure = new TextDecoder().decode(new Uint8Array(evidence.responses.at(-1).workerd.bytes));
  assert.match(expectedFailure, /ValueError: SDK application exception/);
  const recovered = await call('after-error');
  assert.equal(recovered.status, 201);
  assert.deepEqual(await recovered.json(), { body: 'after-error', method: 'POST' });
  const binary = await call('binary');
  assert.equal(binary.status, 200);
  assert.deepEqual([...new Uint8Array(await binary.arrayBuffer())], [0, 1, 127, 255]);
  const background = await call('background');
  assert.equal(background.status, 202, await background.text());
  let value;
  const deadline = Date.now() + 5000;
  do {
    value = await (await call('read-background', false)).text();
    const referenceValue = new TextDecoder().decode(new Uint8Array(evidence.responses.at(-1).workerd.bytes));
    if (value === 'saved' && referenceValue === 'saved') break;
    value = 'pending';
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.equal(value, 'saved');
  const gates = new Map();
  const server = createServer((request, response) => {
    if (request.url.endsWith('/done')) {
      const gate = gates.get(request.url.slice(0, -5));
      if (!gate?.finished) { response.writeHead(404).end(); return; }
      let body = '';
      request.setEncoding('utf8');
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => { response.end('recorded'); gate.finished(JSON.parse(body)); });
      return;
    }
    const gate = gates.get(request.url);
    if (!gate) { response.writeHead(404).end(); return; }
    gate.response = response;
    if (gate.result) gate.result.producerWaiting = true;
    gate.arrived();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    for (const gate of gates.values()) if (!gate.response?.writableEnded) gate.response?.end('cleanup');
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  evidence.streaming = [];
  async function checkStream(name, dispatch) {
    let arrived;
    const waiting = new Promise(resolve => { arrived = resolve; });
    const gate = { arrived };
    gates.set('/' + name, gate);
    const result = { engine: name, stage: 'request' };
    evidence.streaming.push(result);
    gate.result = result;
    const response = await dispatch('http://127.0.0.1:' + server.address().port + '/' + name);
    assert.equal(response.status, 200);
    result.stage = 'headers';
    result.headers = Object.fromEntries(response.headers);
    const reader = response.body.getReader();
    let firstTimer;
    async function readPrefix() {
      const chunks = [];
      let bytes = 0;
      while (bytes < 6) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false, 'stream ended before first prefix');
        chunks.push(chunk.value);
        bytes += chunk.value.byteLength;
      }
      return { value: Buffer.concat(chunks), done: false };
    }
    const first = await Promise.race([readPrefix(), new Promise((_, reject) => { firstTimer = setTimeout(() => reject(new Error(name + ' first chunk timed out')), 5000); })]).finally(() => clearTimeout(firstTimer));
    assert.equal(new TextDecoder().decode(first.value), 'first\n');
    assert.equal(first.done, false);
    result.stage = 'first-chunk';
    // Keep pulling so backpressure can release the producer's first write.
    // The HTTP gate, not withholding demand, prevents the second write.
    let secondSettled = false;
    const second = reader.read();
    second.then(() => { secondSettled = true; }, () => { secondSettled = true; });
    await waiting;
    assert.equal(secondSettled, false);
    result.firstBeforeRelease = true;
    gate.response.end('release');
    const next = await second;
    assert.equal(next.done, false);
    const chunks = [first.value, next.value];
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      chunks.push(item.value);
    }
    result.stage = 'complete';
    result.body = Buffer.concat(chunks).toString();
    assert.equal(result.body, 'first\nsecond\n');
  }
  await checkStream('celld', release => fetch(local.url, { method: 'POST', body: 'stream', headers: { 'x-release-url': release, 'accept-encoding': 'identity' }, signal: AbortSignal.timeout(5000) }));
  await checkStream('workerd', release => reference.dispatchFetch('http://local/', { method: 'POST', body: 'stream', headers: { 'x-release-url': release, 'accept-encoding': 'identity' } }));
  evidence.uploadStreaming = [];
  async function checkUpload(engine, url) {
    const result = { engine, stage: 'request' };
    evidence.uploadStreaming.push(result);
    let controller;
    const body = new ReadableStream({ start(value) { controller = value; value.enqueue(new TextEncoder().encode('first\n')); } });
    try {
      const response = await fetch(url, { method: 'POST', body, duplex: 'half', headers: { 'x-echo-upload': '1', 'accept-encoding': 'identity' }, signal: AbortSignal.timeout(5000) });
      result.stage = 'headers';
      result.status = response.status;
      if (response.status !== 200) result.failureBody = await response.text();
      assert.equal(response.status, 200, result.failureBody);
      const reader = response.body.getReader();
      const chunks = [];
      let length = 0;
      while (length < 6) {
        const item = await reader.read();
        assert.equal(item.done, false);
        chunks.push(item.value);
        length += item.value.byteLength;
      }
      assert.equal(Buffer.concat(chunks).toString(), 'first\n');
      result.firstBeforeUploadClose = true;
      controller.enqueue(new TextEncoder().encode('second\n'));
      controller.close();
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        chunks.push(item.value);
      }
      result.body = Buffer.concat(chunks).toString();
      result.stage = 'complete';
      assert.equal(result.body, 'first\nsecond\n');
    } catch (error) {
      result.error = String(error);
      try { controller.error(error); } catch {}
      throw error;
    }
  }
  const uploads = await Promise.allSettled([
    checkUpload('celld', local.url),
    checkUpload('workerd', await reference.ready),
  ]);
  assert.ok(uploads.every(result => result.status === 'fulfilled'), JSON.stringify(evidence.uploadStreaming));

  evidence.bufferedUpload = [];
  for (const [engine, url] of [['celld', local.url], ['workerd', await reference.ready]]) {
    const response = await fetch(url, { method: 'POST', body: 'buffered upload', headers: { 'x-echo-upload': '1', 'accept-encoding': 'identity' }, signal: AbortSignal.timeout(5000) });
    const body = await response.text();
    evidence.bufferedUpload.push({ engine, status: response.status, body });
    assert.equal(response.status, 200, body);
    assert.equal(body, 'buffered upload');
  }

  evidence.cancellation = [];
  async function checkCancellation(engine, url) {
    const result = { engine, stage: 'request' };
    evidence.cancellation.push(result);
    const gate = {};
    const arrived = new Promise(resolve => { gate.arrived = resolve; });
    const finished = new Promise(resolve => { gate.finished = resolve; });
    const path = '/cancel-' + engine;
    gates.set(path, gate);
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]);
    try {
      const response = await fetch(url, { method: 'POST', body: 'cancel-stream', headers: { 'accept-encoding': 'identity', 'x-release-url': `http://127.0.0.1:${server.address().port}${path}` }, signal });
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      const prefix = [];
      let length = 0;
      while (length < 6) {
        const item = await reader.read();
        assert.equal(item.done, false);
        prefix.push(item.value);
        length += item.value.byteLength;
      }
      assert.equal(Buffer.concat(prefix).toString(), 'first\n');
      await arrived;
      result.stage = 'client-abort';
      controller.abort();
      await reader.cancel().catch(() => {});
      gate.response.end('release');
      let timer;
      try {
        result.producer = await Promise.race([finished, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Python producer did not finish after client abort')), 5000); })]);
      } finally { clearTimeout(timer); }
      result.stage = 'complete';
      assert.equal(result.producer.outcome, 'rejected');
      assert.equal(result.producer.stage, 'writes');
      assert.ok(result.producer.writes < 256);
    } catch (error) { result.error = String(error); throw error; }
  }
  const cancellations = await Promise.allSettled([
    checkCancellation('celld', local.url),
    checkCancellation('workerd', await reference.ready),
  ]);
  assert.ok(cancellations.every(result => result.status === 'fulfilled'), JSON.stringify(evidence.cancellation));
  const afterCancellation = await call('after-cancellation');
  assert.equal(afterCancellation.status, 201);
  assert.deepEqual(await afterCancellation.json(), { body: 'after-cancellation', method: 'POST' });

});
