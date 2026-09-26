import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import workerd from 'workerd';
import { startCelld } from './local-celld.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
test('compiled-module Wasm promises match workerd; byte compilation is probed separately', { timeout: 40000 }, async (t) => {
  const source = await readFile(resolve(root, 'async-wasm-worker.js'), 'utf8');
  const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  const local = await startCelld({ 'index.js': source, 'empty.wasm': wasm });
  t.after(local.close);
  const previousWorkerd = process.env.MINIFLARE_WORKERD_PATH;
  process.env.MINIFLARE_WORKERD_PATH = workerd.default;
  t.after(() => {
    if (previousWorkerd === undefined) delete process.env.MINIFLARE_WORKERD_PATH;
    else process.env.MINIFLARE_WORKERD_PATH = previousWorkerd;
  });
  const reference = new Miniflare(convertV4MiniflareOptions({
    name: 'async-wasm-reference', cf: false, modulesRoot: root,
    compatibilityDate: '2026-09-21', modules: [
      { type: 'ESModule', path: resolve(root, 'index.js'), contents: source },
      { type: 'CompiledWasm', path: resolve(root, 'empty.wasm'), contents: wasm },
    ],
  }));
  t.after(() => reference.dispose());
  await reference.ready;
  const observations = [];
  for (const operation of ['sync', 'instantiate-module', 'compile', 'instantiate-bytes']) {
    const actual = await fetch(`${local.url}/${operation}`, { signal: AbortSignal.timeout(5000) });
    const expected = await reference.dispatchFetch(`http://local/${operation}`);
    observations.push({ operation, celld: await actual.json(), workerd: await expected.json() });
  }
  await mkdir(resolve(root, 'results'), { recursive: true });
  await writeFile(resolve(root, 'results/async-wasm.json'), JSON.stringify({
    timestamp: new Date().toISOString(), workerd: workerd.version, observations,
  }, null, 2) + '\n');
  t.diagnostic(JSON.stringify(observations));
  assert.equal(observations[0].celld.outcome, 'resolved');
  assert.equal(observations[1].workerd.outcome, 'resolved');
  assert.equal(observations[1].celld.outcome, 'resolved');
  if (process.env.WASM_REQUIRE_BYTE_COMPILATION === '1') {
    for (const observation of observations.slice(2)) assert.notEqual(observation.celld.outcome, 'timeout', observation.operation);
  }
});
