import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import workerd from 'workerd';
import { startCelld } from './local-celld.mjs';
const root = new URL('.', import.meta.url);
test('unmodified workers-runtime-sdk wheel serves HTTP, binary, and background KV', { timeout: 30000 }, async (t) => {
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
});
