import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import workerd from 'workerd';
import { startCelld } from './local-celld.mjs';
const root = new URL('.', import.meta.url);
test('native SDK Durable Object preserves SQL across abort and process restart and runs alarms', { timeout: 60000 }, async (t) => {
  const source = await readFile(new URL('native-durable.py', root), 'utf8');
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
  const expectedSdk = createHash('sha256').update(execFileSync('unzip', ['-p', wheel, 'workers/entrypoints.py'])).digest('hex');
  const names = execFileSync('unzip', ['-Z1', wheel], { encoding: 'utf8' }).trim().split('\n');
  const modules = names.filter(name => name.startsWith('workers/') && name.endsWith('.py')).map(name => ({ type: 'Data', path: resolve(fileURLToPath(root), 'python_modules', name), contents: execFileSync('unzip', ['-p', wheel, name]) }));
  const reference = new Miniflare(convertV4MiniflareOptions({
    name: 'native-durable-reference', cf: false, modulesRoot: fileURLToPath(root),
    compatibilityDate: '2025-06-01', compatibilityFlags: ['python_workers', 'python_workers_20250116'],
    modules: [{ type: 'PythonModule', path: fileURLToPath(new URL('native-durable-reference.py', root)), contents: "import sys\nsys.path.insert(0, '/session/metadata/python_modules')\n" + source + '\nDefault.on_fetch = Default.fetch\nCounter.on_fetch = Counter.fetch\nCounter.on_alarm = Counter.alarm\n' }, ...modules],
    durableObjects: { COUNTER: { className: 'Counter', useSQLite: true } },
  }));
  t.after(() => reference.dispose());
  const evidence = { timestamp: new Date().toISOString(), workerd: workerd.version, referenceDate: '2025-06-01', sourceSha256: createHash('sha256').update(source).digest('hex'), responses: [] };
  t.after(async () => {
    await mkdir(new URL('results/', root), { recursive: true });
    await writeFile(new URL('results/native-durable.json', root), JSON.stringify(evidence, null, 2) + '\n');
  });
  async function call(operation, success = true) {
    const response = await fetch(local.url, { method: 'POST', body: operation, signal: AbortSignal.timeout(10000) });
    const text = await response.text();
    const expected = await reference.dispatchFetch('http://local/', { method: 'POST', body: operation });
    const referenceText = await expected.text();
    evidence.responses.push({ operation, status: response.status, text, reference: { status: expected.status, text: referenceText } });
    assert.equal(response.status, expected.status, referenceText);
    if (success) {
      assert.equal(JSON.parse(text).value, JSON.parse(referenceText).value);
      assert.equal(JSON.parse(text).sdk, expectedSdk);
      assert.equal(JSON.parse(referenceText).sdk, expectedSdk);
    }
    if (!success) { assert.equal(response.status, 500); return; }
    assert.equal(response.status, 200, text);
    return JSON.parse(text);
  }
  const initial = await call('inc');
  assert.equal(initial.value, 1);
  assert.equal((await call('inc')).value, 2);
  await call('rollback', false);
  assert.equal((await call('read')).value, 2);
  await call('abort', false);
  const recovered = await call('read');
  assert.equal(recovered.value, 2);
  assert.notEqual(recovered.instance, initial.instance);
  assert.notEqual(JSON.parse(evidence.responses.at(-1).reference.text).instance, JSON.parse(evidence.responses[0].reference.text).instance);
  await call('arm');
  let fired;
  const deadline = Date.now() + 10000;
  do {
    fired = await call('read');
    if (fired.fires === 1 && JSON.parse(evidence.responses.at(-1).reference.text).fires === 1) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.equal(fired.fires, 1);
  assert.equal(JSON.parse(evidence.responses.at(-1).reference.text).fires, 1);
  evidence.restart = await local.restart({ crash: true });
  const restored = await call('read');
  assert.equal(restored.value, 2);
  assert.equal(restored.fires, 1);
  assert.notEqual(restored.instance, recovered.instance);
});
