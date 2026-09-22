import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import workerd from 'workerd';
import { startCelld } from './local-celld.mjs';
const root = fileURLToPath(new URL('.', import.meta.url));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function deadline(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), 5000); })]); }
  finally { clearTimeout(timer); }
}
test('ASGI response bytes precede producer release and disconnect reaches cleanup and lifespan shutdown', { timeout: 60000 }, async (t) => {
  const source = await readFile(join(root, 'asgi-stream.py'), 'utf8');
  const evidence = { timestamp: new Date().toISOString(), workerd: workerd.version, compatibilityDate: '2025-06-01', observations: [] };
  t.after(async () => {
    await mkdir(join(root, 'results'), { recursive: true });
    await writeFile(join(root, 'results/asgi-stream.json'), JSON.stringify(evidence, null, 2) + '\n');
  });
  const gates = new Map();
  const server = createServer(async (request, response) => {
    const [, id, action] = request.url.split('/');
    const gate = gates.get(id);
    if (!gate) { response.writeHead(404).end(); return; }
    if (!action) { gate.response = response; gate.arrived.resolve(); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    response.end('ok');
    if (action === 'producer') gate.producer.resolve(JSON.parse(body));
    if (action === 'shutdown') gate.shutdown.resolve(body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const local = await startCelld({ 'worker.py': source }, { main: 'worker.py', no_bundle: false, compatibility_flags: ['python_workers'] }, { CELLD_PYTHON_BUILD: join(root, 'build-project.mjs') });
  t.after(local.close);
  const previous = process.env.MINIFLARE_WORKERD_PATH;
  process.env.MINIFLARE_WORKERD_PATH = workerd.default;
  t.after(() => { if (previous === undefined) delete process.env.MINIFLARE_WORKERD_PATH; else process.env.MINIFLARE_WORKERD_PATH = previous; });
  const wheel = join(root, '.celld/workers_runtime_sdk-1.9.0-py3-none-any.whl');
  const modules = execFileSync('unzip', ['-Z1', wheel], { encoding: 'utf8' }).trim().split('\n').filter(name => name.startsWith('workers/') && name.endsWith('.py')).map(name => ({ type: 'Data', path: join(root, 'python_modules', name), contents: execFileSync('unzip', ['-p', wheel, name]) }));
  const reference = new Miniflare(convertV4MiniflareOptions({ name: 'asgi-stream-reference', cf: false, modulesRoot: root, compatibilityDate: '2025-06-01', compatibilityFlags: ['python_workers', 'python_workers_20250116'], modules: [{ type: 'PythonModule', path: join(root, 'asgi-stream-reference.py'), contents: "import sys\nsys.path.insert(0, '/session/metadata/python_modules')\n" + source + '\nDefault.on_fetch = Default.fetch\n' }, ...modules] }));
  t.after(() => reference.dispose());
  for (const [engine, url] of [['celld', local.url], ['workerd', String(await reference.ready)]]) {
    for (const mode of ['stream', 'cancel', 'recovery']) {
      const gate = { arrived: deferred(), producer: deferred(), shutdown: deferred() };
      const id = engine + '-' + mode;
      gates.set(id, gate);
      const observation = { engine, mode };
      evidence.observations.push(observation);
      const controller = new AbortController();
      try {
        const response = await fetch(new URL('/' + mode, url), { headers: { 'x-gate': `http://127.0.0.1:${server.address().port}/${id}`, 'accept-encoding': 'identity' }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]) });
        assert.equal(response.status, 200, await (response.status === 200 ? Promise.resolve('') : response.text()));
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        while (size < 6) {
          const chunk = await deadline(reader.read(), engine + ' first bytes never arrived');
          assert.equal(chunk.done, false);
          chunks.push(chunk.value); size += chunk.value.length;
        }
        assert.equal(Buffer.concat(chunks).toString(), 'first\n');
        let settled = false;
        const next = reader.read();
        next.then(() => { settled = true; }, () => { settled = true; });
        await deadline(gate.arrived.promise, 'Producer never reached its release gate');
        assert.equal(settled, false);
        observation.firstBeforeRelease = true;
        if (mode === 'cancel') {
          controller.abort();
          await reader.cancel().catch(() => {});
          await next.catch(() => {});
          gate.response.end('release');
        } else {
          gate.response.end('release');
          let chunk = await deadline(next, 'Second bytes never arrived');
          while (!chunk.done) { chunks.push(chunk.value); chunk = await deadline(reader.read(), 'Response never finished'); }
          observation.body = Buffer.concat(chunks).toString();
          assert.equal(observation.body, 'first\nsecond\n');
        }
        observation.producer = await deadline(gate.producer.promise, 'ASGI producer did not finish');
        observation.shutdown = await deadline(gate.shutdown.promise, 'ASGI lifespan did not shut down');
        assert.equal(observation.shutdown, 'closed');
        assert.equal(observation.producer.outcome, mode === 'cancel' ? 'rejected' : 'complete');
        if (mode === 'cancel') assert.ok(observation.producer.writes < 256);
      } catch (error) { observation.error = String(error); throw error; }
      finally { controller.abort(); if (gate.response && !gate.response.writableEnded) gate.response.end('cleanup'); }
    }
  }
});
