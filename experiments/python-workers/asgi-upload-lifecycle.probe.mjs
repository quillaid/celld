import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import workerd from 'workerd';
import { startCelld } from './local-celld.mjs';
const root = fileURLToPath(new URL('.', import.meta.url));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function deadline(promise, message) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 5000); })]); } finally { clearTimeout(timer); } }
test('ASGI upload candidate releases unread bodies and delivers upload disconnect events', { timeout: 60000 }, async (t) => {
  const source = await readFile(join(root, 'asgi-upload-lifecycle.py'), 'utf8');
  const candidate = await readFile(join(root, 'asgi_upload_candidate.py'), 'utf8');
  const evidence = { timestamp: new Date().toISOString(), sdkMode: 'test-only receive candidate', candidateSha256: createHash('sha256').update(candidate).digest('hex'), workerd: workerd.version, observations: [] };
  t.after(async () => { await mkdir(join(root, 'results'), { recursive: true }); await writeFile(join(root, 'results/asgi-upload-lifecycle.json'), JSON.stringify(evidence, null, 2) + '\n'); });
  const gates = new Map();
  const server = createServer(async (req, res) => {
    const [, id, action] = req.url.split('/');
    const gate = gates.get(id);
    if (!gate) { res.writeHead(404).end(); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString(); res.end('ok');
    if (action === 'waiting') gate.waiting.resolve();
    if (action === 'finished') gate.finished.resolve(JSON.parse(text));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const local = await startCelld({ 'worker.py': source, 'asgi_upload_candidate.py': candidate }, { main: 'worker.py', no_bundle: false, compatibility_flags: ['python_workers'] }, { CELLD_PYTHON_BUILD: join(root, 'build-project.mjs') });
  t.after(local.close);
  const previous = process.env.MINIFLARE_WORKERD_PATH; process.env.MINIFLARE_WORKERD_PATH = workerd.default;
  t.after(() => { if (previous === undefined) delete process.env.MINIFLARE_WORKERD_PATH; else process.env.MINIFLARE_WORKERD_PATH = previous; });
  const wheel = join(root, '.celld/workers_runtime_sdk-1.9.0-py3-none-any.whl');
  const modules = execFileSync('unzip', ['-Z1', wheel], { encoding: 'utf8' }).trim().split('\n').filter(name => name.startsWith('workers/') && name.endsWith('.py')).map(name => ({ type: 'Data', path: join(root, 'python_modules', name), contents: execFileSync('unzip', ['-p', wheel, name]) }));
  modules.push({ type: 'Data', path: join(root, 'python_modules/asgi_upload_candidate.py'), contents: candidate });
  const reference = new Miniflare(convertV4MiniflareOptions({ name: 'asgi-upload-lifecycle-reference', cf: false, modulesRoot: root, compatibilityDate: '2025-06-01', compatibilityFlags: ['python_workers', 'python_workers_20250116'], modules: [{ type: 'PythonModule', path: join(root, 'asgi-upload-lifecycle-reference.py'), contents: "import sys\nsys.path.insert(0, '/session/metadata/python_modules')\n" + source + '\nDefault.on_fetch = Default.fetch\n' }, ...modules] }));
  t.after(() => reference.dispose());
  for (const [engine, url] of [['celld', local.url], ['workerd', String(await reference.ready)]]) {
    const observation = { engine }; evidence.observations.push(observation);
    for (const mode of ['early', 'partial', 'app-error']) {
      let upload;
      const body = new ReadableStream({ start(controller) { upload = controller; controller.enqueue(new TextEncoder().encode('first\n')); } });
      try {
        const response = await fetch(new URL('/' + mode, url), { method: 'POST', body, duplex: 'half', signal: AbortSignal.timeout(10000) });
        observation[mode] = { status: response.status, body: await response.text(), locked: response.headers.get('x-body-locked'), done: response.headers.get('x-body-done') };
        assert.equal(observation[mode].status, mode === 'app-error' ? 500 : 200);
        assert.equal(observation[mode].body, mode === 'app-error' ? 'app-error' : 'early');
      } finally { try { upload.close(); } catch {} }
    }
    const gate = { waiting: deferred(), finished: deferred() }; gates.set(engine, gate);
    const abort = new AbortController();
    let cancelUpload;
    try {
      const body = new ReadableStream({ start(controller) { cancelUpload = controller; controller.enqueue(new TextEncoder().encode('first\n')); } });
      const response = await fetch(new URL('/cancel', url), { method: 'POST', body, duplex: 'half', headers: { 'accept-encoding': 'identity', 'x-gate': `http://127.0.0.1:${server.address().port}/${engine}` }, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]) });
      assert.equal(response.status, 200);
      const reader = response.body.getReader(); const chunks = []; let length = 0;
      while (length < 6) { const chunk = await deadline(reader.read(), 'No response prefix'); assert.equal(chunk.done, false); chunks.push(chunk.value); length += chunk.value.length; }
      assert.equal(Buffer.concat(chunks).toString(), 'ready\n');
      await deadline(gate.waiting.promise, 'App did not enter receive phase');
      abort.abort(); await reader.cancel().catch(() => {});
      observation.disconnect = await deadline(gate.finished.promise, 'ASGI receive did not finish after upload abort');
    } finally { abort.abort(); try { cancelUpload.error(new Error('probe cleanup')); } catch {} }
    const cancelGate = { waiting: deferred(), finished: deferred() };
    gates.set(engine + '-task', cancelGate);
    const request = httpRequest(new URL('/task-cancel', url), { method: 'POST', headers: { 'transfer-encoding': 'chunked', 'x-gate': `http://127.0.0.1:${server.address().port}/${engine}-task` } });
    const completed = new Promise((resolve, reject) => {
      request.on('error', reject);
      request.on('response', async response => {
        try { const chunks = []; for await (const chunk of response) chunks.push(chunk); resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString(), locked: response.headers['x-body-locked'], done: response.headers['x-body-done'] }); }
        catch (error) { reject(error); }
      });
    });
    completed.catch(() => {});
    try {
      request.flushHeaders();
      // No body bytes exist yet: cancellation must finish before the chunk
      // is released, so a consumed/lost first chunk cannot pass by timing luck.
      await deadline(cancelGate.waiting.promise, 'Pending receive cancellation did not finish');
      request.end('first\n');
      observation.taskCancellation = await deadline(completed, 'Retried receive did not finish');
    } finally { request.destroy(); }
    const recovery = await fetch(new URL('/early', url), { method: 'POST', body: 'recovery', signal: AbortSignal.timeout(5000) });
    observation.recovery = { status: recovery.status, body: await recovery.text(), locked: recovery.headers.get('x-body-locked'), done: recovery.headers.get('x-body-done') };
  }
  for (const observation of evidence.observations) {
    assert.equal(observation.early.locked, 'false', JSON.stringify(evidence));
    assert.equal(observation.early.done, 'true', JSON.stringify(evidence));
    assert.deepEqual(observation.partial, { status: 200, body: 'early', locked: 'false', done: 'true' });
    assert.deepEqual(observation['app-error'], { status: 500, body: 'app-error', locked: 'false', done: 'true' });
    assert.deepEqual(observation.disconnect, { event: 'http.disconnect' }, JSON.stringify(evidence));
    assert.equal(observation.taskCancellation.status, 200, observation.taskCancellation.body);
    assert.deepEqual(JSON.parse(observation.taskCancellation.body), { cancelled: [true, true, true], body: 'first\n' }, JSON.stringify(evidence));
    assert.equal(observation.taskCancellation.locked, 'false');
    assert.equal(observation.taskCancellation.done, 'true');
    assert.deepEqual(observation.recovery, { status: 200, body: 'early', locked: 'false', done: 'true' });
  }
});
