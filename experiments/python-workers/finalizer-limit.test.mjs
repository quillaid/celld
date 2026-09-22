import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { startCelld } from './local-celld.mjs';
const root = fileURLToPath(new URL('.', import.meta.url));
test('Python facet finalizer is CPU-bounded and a replacement retains acknowledged SQL', { timeout: 60000 }, async t => {
  const project = await mkdtemp(resolve(root, '.celld/finalizer-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  await writeFile(resolve(project, 'worker.py'), await readFile(resolve(root, 'finalizer-limit.py')));
  const output = resolve(project, 'built');
  execFileSync(process.execPath, [resolve(root, 'build-project.mjs'), resolve(project, 'worker.py'), output, '["Counter"]'], { timeout: 20000 });
  const files = { 'python-source': ['index.js', 'text'], 'python-wasm': ['pyodide.asm.wasm', 'binary'], 'python-sentinel': ['sentinel.wasm', 'binary'] };
  const bundle = await build({ absWorkingDir: root, entryPoints: ['finalizer-limit-driver.js'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'], plugins: [{ name: 'python-runtime', setup(builder) {
    builder.onResolve({ filter: /^python-/ }, args => ({ path: args.path, namespace: 'python' }));
    builder.onLoad({ filter: /.*/, namespace: 'python' }, async args => ({ contents: await readFile(resolve(output, files[args.path][0])), loader: files[args.path][1] }));
  } }] });
  const local = await startCelld({ 'index.js': bundle.outputFiles[0].text }, {
    worker_loaders: [{ binding: 'LOADER' }], durable_objects: { bindings: [{ name: 'PARENT', class_name: 'Parent' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['Parent'] }],
  });
  t.after(local.close);
  const evidence = { timestamp: new Date().toISOString() };
  t.after(async () => { evidence.logs = local.logs(); await mkdir(resolve(root, 'results'), { recursive: true }); await writeFile(resolve(root, 'results/finalizer-limit.json'), JSON.stringify(evidence, null, 2) + '\n'); });
  const response = await fetch(local.url, { signal: AbortSignal.timeout(20000) });
  evidence.status = response.status; evidence.body = await response.text();
  assert.equal(response.status, 200, evidence.body);
  const result = JSON.parse(evidence.body);
  assert.match(result.failure, /CPU|cpu/);
  assert.match(result.afterTermination, /Python runtime invalidated after execution termination/);
  assert.ok(result.elapsedMs < 7000);
  assert.equal(result.witness.count, 1);
  assert.equal(result.replacement.count, 1);
  assert.equal(result.controlBefore.finalized, 0);
  assert.equal(result.controlAfter.finalized, 1, 'unarmed cleanup control must run the same finalizer successfully');
  assert.notEqual(result.controlAfter.instance, result.controlBefore.instance);
  assert.equal(result.armed.instance, result.controlAfter.instance);
  assert.notEqual(result.replacement.instance, result.witness.instance);
});
