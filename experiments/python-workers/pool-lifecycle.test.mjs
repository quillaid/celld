import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { startCelld } from './local-celld.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
test('pooled Python interpreters are replaced after hard termination', { timeout: 45000 }, async (t) => {
  // Use the real Python adapter. A fixture-only JS capability calls the host
  // termination API from inside Python; top-level HTTP has no per-call CPU knob.
  const source = `globalThis.fixture_exit = globalThis.process.exit;\n`
    + await readFile(resolve(root, 'dist/index.js'), 'utf8');
  const local = await startCelld({
    'index.js': source,
    'pyodide.asm.wasm': await readFile(resolve(root, 'dist/pyodide.asm.wasm')),
    'sentinel.wasm': await readFile(resolve(root, 'dist/sentinel.wasm')),
  }, { compatibility_flags: ['python_workers', 'nodejs_compat'] }, {
    CELLD_MAX_STATELESS_ISOLATES: '1',
  });
  t.after(local.close);
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const response = await fetch(local.url, { method: 'POST', body: 'warm', signal: AbortSignal.timeout(7000) });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    const instance = response.headers.get('x-python-instance-id');
    assert.ok(instance);
    const terminated = await fetch(local.url, { method: 'POST', body: 'exit', signal: AbortSignal.timeout(5000) });
    const error = await terminated.text();
    assert.equal(terminated.status, 500, error);
    assert.match(error, /process.exit\(1\)/);
    samples.push({ instance, termination: error });
  }
  assert.equal(new Set(samples.map((sample) => sample.instance)).size, samples.length);
  await mkdir(resolve(root, 'results'), { recursive: true });
  await writeFile(resolve(root, 'results/pool-lifecycle.json'), JSON.stringify({
    timestamp: new Date().toISOString(), terminationTrigger: 'Python FFI to globalThis.process.exit(1)',
    maxStatelessIsolates: 1, samples,
  }, null, 2) + '\n');
});
