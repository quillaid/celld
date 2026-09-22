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
test('native Python Durable Object RPC methods match workerd and retain SQL state', { timeout: 60000 }, async (t) => {
  const source = await readFile(new URL('native-rpc.py', root), 'utf8');
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
    name: 'native-rpc-reference', cf: false, modulesRoot: fileURLToPath(root),
    compatibilityDate: '2025-06-01', compatibilityFlags: ['python_workers', 'python_workers_20250116'],
    modules: [{ type: 'PythonModule', path: fileURLToPath(new URL('native-rpc-reference.py', root)), contents: "import sys\nsys.path.insert(0, '/session/metadata/python_modules')\n" + source + '\nDefault.on_fetch = Default.fetch\n' }, ...modules],
    durableObjects: { COUNTER: { className: 'Counter', useSQLite: true } },
  }));
  t.after(() => reference.dispose());
  const evidence = { timestamp: new Date().toISOString(), workerd: workerd.version, referenceDate: '2025-06-01', responses: [] };
  t.after(async () => {
    await mkdir(new URL('results/', root), { recursive: true });
    await writeFile(new URL('results/native-rpc.json', root), JSON.stringify(evidence, null, 2) + '\n');
  });
  async function call(input, success = true, errorPattern = /Python RPC failure/) {
    const response = await fetch(local.url, { method: 'POST', body: JSON.stringify(input), signal: AbortSignal.timeout(10000) });
    const text = await response.text();
    const observation = { input, status: response.status, text };
    evidence.responses.push(observation);
    const expected = await reference.dispatchFetch('http://local/', { method: 'POST', body: JSON.stringify(input) });
    const referenceText = await expected.text();
    observation.reference = { status: expected.status, text: referenceText };
    assert.equal(response.status, expected.status, JSON.stringify(observation));
    assert.equal(response.status, success ? 200 : 500, text);
    if (success) {
      assert.deepEqual(JSON.parse(text), JSON.parse(referenceText));
      return JSON.parse(text);
    }
    assert.match(text, errorPattern);
    assert.match(referenceText, errorPattern);
  }
  assert.deepEqual(await call({ operation: 'increment', amount: 2 }), { value: 2 });
  const payload = { nested: [null, true, 3.25, 'python'], record: { key: 'value' } };
  assert.deepEqual(await call({ operation: 'echo', payload }), { payload, value: 2 });
  assert.deepEqual(await call({ operation: 'inherited', value: 42 }), { inherited: 42 });
  await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    const payload = { index, nested: [null, 'request-' + index] };
    assert.deepEqual(await call({ operation: 'echo', payload }), { payload, value: 2 });
  }));
  assert.deepEqual(await call({ operation: 'increment', amount: 7, name: 'second' }), { value: 7 });
  assert.deepEqual(await call({ operation: 'read' }), { value: 2 });
  await call({ operation: 'fail' }, false);
  assert.deepEqual(await call({ operation: 'private' }), { private: 'visible' });
  assert.deepEqual(await call({ operation: 'static', value: 19 }), { static: 19 });
  assert.deepEqual(await call({ operation: 'class' }), { class: 'Counter' });
  assert.deepEqual(await call({ operation: 'installed', value: 23 }), { installed: 23 });
  assert.deepEqual(await call({ operation: 'read' }), { value: 2 });
  evidence.restart = await local.restart({ crash: true });
  assert.deepEqual(await call({ operation: 'read' }), { value: 2 });
});
