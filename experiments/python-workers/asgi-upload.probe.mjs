// A contract probe, intentionally outside the green regression suite until
// the pinned SDK's eager request-body buffering has been resolved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import workerd from 'workerd';
import { startCelld } from './local-celld.mjs';
const root = fileURLToPath(new URL('.', import.meta.url));
test('ASGI exposes the first upload bytes before the client finishes the request', { timeout: 60000 }, async (t) => {
  const candidate = process.env.CELLD_ASGI_UPLOAD_CANDIDATE === '1';
  const candidateSource = candidate ? await readFile(join(root, 'asgi_upload_candidate.py'), 'utf8') : undefined;
  const source = (candidate ? 'import asgi_upload_candidate\n' : '') + await readFile(join(root, 'asgi-upload.py'), 'utf8');
  const evidence = { timestamp: new Date().toISOString(), workerd: workerd.version, compatibilityDate: '2025-06-01', firstByteWindowMs: 1500, sdkMode: candidate ? 'test-only demand-driven receive candidate' : 'unchanged SDK 1.9.0', candidateSha256: candidate ? createHash('sha256').update(candidateSource).digest('hex') : undefined, baseAsgiSha256: 'f606250b2087c7bfffcdcae8a9dd95f080954820e457e932daa77803c4fdd35d', observations: [] };
  t.after(async () => {
    await mkdir(join(root, 'results'), { recursive: true });
    await writeFile(join(root, candidate ? 'results/asgi-upload-candidate.json' : 'results/asgi-upload.json'), JSON.stringify(evidence, null, 2) + '\n');
  });
  const local = await startCelld({ 'worker.py': source, ...(candidate ? { 'asgi_upload_candidate.py': candidateSource } : {}) }, { main: 'worker.py', no_bundle: false, compatibility_flags: ['python_workers'] }, { CELLD_PYTHON_BUILD: join(root, 'build-project.mjs') });
  t.after(local.close);
  const previous = process.env.MINIFLARE_WORKERD_PATH;
  process.env.MINIFLARE_WORKERD_PATH = workerd.default;
  t.after(() => { if (previous === undefined) delete process.env.MINIFLARE_WORKERD_PATH; else process.env.MINIFLARE_WORKERD_PATH = previous; });
  const wheel = join(root, '.celld/workers_runtime_sdk-1.9.0-py3-none-any.whl');
  const modules = execFileSync('unzip', ['-Z1', wheel], { encoding: 'utf8' }).trim().split('\n').filter(name => name.startsWith('workers/') && name.endsWith('.py')).map(name => ({ type: 'Data', path: join(root, 'python_modules', name), contents: execFileSync('unzip', ['-p', wheel, name]) }));
  if (candidate) modules.push({ type: 'Data', path: join(root, 'python_modules/asgi_upload_candidate.py'), contents: candidateSource });
  const reference = new Miniflare(convertV4MiniflareOptions({ name: 'asgi-upload-reference', cf: false, modulesRoot: root, compatibilityDate: '2025-06-01', compatibilityFlags: ['python_workers', 'python_workers_20250116'], modules: [{ type: 'PythonModule', path: join(root, 'asgi-upload-reference.py'), contents: "import sys\nsys.path.insert(0, '/session/metadata/python_modules')\n" + source + '\nDefault.on_fetch = Default.fetch\n' }, ...modules] }));
  t.after(() => reference.dispose());
  for (const [engine, url] of [['celld', local.url], ['workerd', String(await reference.ready)]]) {
    const warm = await fetch(new URL('/direct', url), { method: 'POST', body: 'warm', signal: AbortSignal.timeout(10000) });
    const warmBody = await warm.text();
    assert.equal(warm.status, 200, warmBody);
    assert.equal(warmBody, 'warm');
    for (const mode of ['direct', 'asgi', 'direct-recovery']) {
      const observation = { engine, mode };
      evidence.observations.push(observation);
      let upload;
      const body = new ReadableStream({ start(controller) { upload = controller; controller.enqueue(new TextEncoder().encode('first\n')); } });
      let timer;
      const abort = new AbortController();
      try {
        const responsePromise = fetch(new URL(mode === 'asgi' ? '/asgi' : '/direct', url), { method: 'POST', body, duplex: 'half', headers: { 'accept-encoding': 'identity' }, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]) });
        let reader;
        const chunks = [];
        const prefix = (async () => {
          const response = await responsePromise;
          observation.status = response.status;
          assert.equal(response.status, 200);
          reader = response.body.getReader();
          let length = 0;
          while (length < 6) {
            const item = await reader.read();
            assert.equal(item.done, false);
            chunks.push(item.value); length += item.value.length;
          }
          return true;
        })();
        observation.firstBeforeUploadClose = await Promise.race([prefix, new Promise(resolve => { timer = setTimeout(() => resolve(false), evidence.firstByteWindowMs); })]);
        clearTimeout(timer);
        if (observation.firstBeforeUploadClose) assert.equal(Buffer.concat(chunks).toString(), 'first\n');
        // Rescue a non-streaming implementation so both engines and their
        // controls are observed, rather than stopping at the first timeout.
        upload.enqueue(new TextEncoder().encode('second\n'));
        upload.close();
        await prefix;
        while (true) { const item = await reader.read(); if (item.done) break; chunks.push(item.value); }
        observation.body = Buffer.concat(chunks).toString();
        assert.equal(observation.body, 'first\nsecond\n');
      } catch (error) { observation.error = String(error); throw error; }
      finally { clearTimeout(timer); abort.abort(); try { upload.error(new Error('probe cleanup')); } catch {} }
    }
  }
  assert.ok(evidence.observations.filter(item => item.mode !== 'asgi').every(item => item.firstBeforeUploadClose), 'Direct SDK transport controls must stream');
  assert.ok(evidence.observations.filter(item => item.mode === 'asgi').every(item => item.firstBeforeUploadClose), 'ASGI buffered the upload on one or both engines; see retained observations');
});
