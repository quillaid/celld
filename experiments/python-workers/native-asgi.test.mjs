import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import workerd from 'workerd';
import { startCelld } from './local-celld.mjs';
const root = new URL('.', import.meta.url);
test('released Python ASGI adapter matches workerd HTTP streaming and lifespan', { timeout: 60000 }, async (t) => {
  const source = await readFile(new URL('native-asgi.py', root), 'utf8');
  const local = await startCelld({ 'worker.py': source }, {
    main: 'worker.py', no_bundle: false, compatibility_flags: ['python_workers'],
    kv_namespaces: [{ binding: 'RESULTS', id: 'asgi-results' }],
  }, { CELLD_PYTHON_BUILD: fileURLToPath(new URL('build-project.mjs', root)) });
  t.after(local.close);
  const previous = process.env.MINIFLARE_WORKERD_PATH;
  process.env.MINIFLARE_WORKERD_PATH = workerd.default;
  t.after(() => { if (previous === undefined) delete process.env.MINIFLARE_WORKERD_PATH; else process.env.MINIFLARE_WORKERD_PATH = previous; });
  const wheel = fileURLToPath(new URL('.celld/workers_runtime_sdk-1.9.0-py3-none-any.whl', root));
  const names = execFileSync('unzip', ['-Z1', wheel], { encoding: 'utf8' }).trim().split('\n');
  const modules = names.filter(name => name.startsWith('workers/') && name.endsWith('.py')).map(name => ({ type: 'Data', path: resolve(fileURLToPath(root), 'python_modules', name), contents: execFileSync('unzip', ['-p', wheel, name]) }));
  const reference = new Miniflare(convertV4MiniflareOptions({
    name: 'native-asgi-reference', cf: false, modulesRoot: fileURLToPath(root),
    kvNamespaces: ['RESULTS'],
    compatibilityDate: '2025-06-01', compatibilityFlags: ['python_workers', 'python_workers_20250116'],
    modules: [{ type: 'PythonModule', path: fileURLToPath(new URL('native-asgi-reference.py', root)), contents: "import sys\nsys.path.insert(0, '/session/metadata/python_modules')\n" + source + '\nDefault.on_fetch = Default.fetch\n' }, ...modules],
  }));
  t.after(() => reference.dispose());
  const evidence = { timestamp: new Date().toISOString(), workerd: workerd.version, referenceDate: '2025-06-01', responses: [] };
  t.after(async () => {
    await mkdir(new URL('results/', root), { recursive: true });
    await writeFile(new URL('results/native-asgi.json', root), JSON.stringify(evidence, null, 2) + '\n');
  });
  await Promise.all(Array.from({ length: 4 }, async (_, index) => {
    const path = '/caf%C3%A9?request=' + index;
    const init = { method: 'POST', body: 'payload-' + index };
    const actual = await fetch(local.url + path, { ...init, signal: AbortSignal.timeout(10000) });
    const expected = await reference.dispatchFetch('http://local' + path, init);
    const observation = { index, actual: { status: actual.status, header: actual.headers.get('x-asgi'), body: await actual.text() }, expected: { status: expected.status, header: expected.headers.get('x-asgi'), body: await expected.text() } };
    evidence.responses.push(observation);
    assert.equal(observation.actual.status, 201, observation.actual.body);
    assert.deepEqual(observation.actual, observation.expected);
    assert.deepEqual(JSON.parse(observation.actual.body), { path: '/café', query: 'request=' + index, body: 'payload-' + index, state: { startup: 'ready' } });
    for (const engine of ['celld', 'workerd']) {
      const deadline = Date.now() + 5000;
      while (true) {
        const path = '/shutdown?request=' + index;
        const response = engine === 'celld' ? await fetch(local.url + path) : await reference.dispatchFetch('http://local' + path);
        const body = await response.text();
        assert.equal(response.status, 200, body);
        if (body === 'closed') { observation[engine + 'Shutdown'] = body; break; }
        assert.ok(Date.now() < deadline, engine + ' lifespan shutdown did not complete');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
  }));
});
