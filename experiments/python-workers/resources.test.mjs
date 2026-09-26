import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCelld } from './local-celld.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
test('Python interpreter resource lifecycle inside a real Dynamic Worker', { timeout: 60000 }, async (t) => {
  const bundled = await build({
    absWorkingDir: root, entryPoints: ['resource-driver.js'], bundle: true, write: false,
    format: 'esm', platform: 'browser', target: 'es2022', loader: { '.wasm': 'binary' },
    plugins: [{ name: 'worker-as-text', setup(builder) {
      builder.onLoad({ filter: /dist\/index\.js$/ }, async (args) => ({ contents: await readFile(args.path, 'utf8'), loader: 'text' }));
    } }],
  });
  const local = await startCelld({ 'index.js': bundled.outputFiles[0].text }, {
    worker_loaders: [{ binding: 'LOADER' }],
  });
  t.after(local.close);
  const evidence = { timestamp: new Date().toISOString() };
  await t.test('bounded allocations reuse one interpreter and plateau in linear memory', async () => {
    const response = await fetch(`${local.url}/memory`, { signal: AbortSignal.timeout(25000) });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    const result = JSON.parse(body);
    evidence.memory = result;
    const ids = new Set(result.samples.map((sample) => sample.instance));
    assert.equal(ids.size, 1);
    const memory = result.samples.slice(2).map((sample) => sample.linearMemory);
    assert.ok(memory.every((bytes) => bytes === memory[0]), JSON.stringify(memory));
  });
  await t.test('CPU limit interrupts Python', async () => {
    const response = await fetch(`${local.url}/terminate-only`, { signal: AbortSignal.timeout(15000) });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    evidence.terminationOnly = JSON.parse(body);
    assert.match(JSON.stringify(evidence.terminationOnly.termination), /CPU|cpu/);
    assert.ok(evidence.terminationOnly.terminationElapsedMs < 3000);
  });
  await t.test('an interrupted interpreter has a defined lifecycle and a replacement serves', async () => {
    const response = await fetch(`${local.url}/terminate`, { signal: AbortSignal.timeout(15000) });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    evidence.termination = JSON.parse(body);
    const { warm, termination, terminationElapsedMs, after, secondAfter, pending, replacement } = evidence.termination;
    assert.equal(warm.status, 200);
    assert.match(JSON.stringify(termination), /CPU|cpu/);
    assert.ok(terminationElapsedMs < 3000, `CPU termination took ${terminationElapsedMs}ms`);
    assert.equal(replacement.status, 200, JSON.stringify(replacement));
    assert.notEqual(replacement.instance, warm.instance);
    for (const result of [after, secondAfter, pending]) {
      assert.match(result.error ?? '', /Python runtime invalidated after execution termination; recreate the worker/, JSON.stringify(result));
    }
  });
  await mkdir(resolve(root, 'results'), { recursive: true });
  await writeFile(resolve(root, 'results/resources.json'), JSON.stringify(evidence, null, 2) + '\n');
  t.diagnostic(JSON.stringify(evidence));
});
