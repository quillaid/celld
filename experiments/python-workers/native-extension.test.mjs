import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startCelld } from './local-celld.mjs';
const root = fileURLToPath(new URL('.', import.meta.url));
const exec = promisify(execFile);
test('native Python executes the compiled MarkupSafe extension from a pinned Wasm wheel', { timeout: 60000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'celld-python-extension-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requirements = 'MarkupSafe==3.0.2\n';
  await writeFile(join(directory, 'requirements.txt'), requirements);
  await exec(process.execPath, [join(root, 'lock-packages.mjs'), directory], { timeout: 20000 });
  const lockText = await readFile(join(directory, 'celld-python.lock.json'), 'utf8');
  const evidence = { timestamp: new Date().toISOString(), lock: JSON.parse(lockText), responses: [] };
  let local;
  t.after(async () => {
    await mkdir(join(root, 'results'), { recursive: true });
    await writeFile(join(root, 'results/native-extension.json'), JSON.stringify({ ...evidence, logs: local?.logs() }, null, 2) + '\n');
  });
  const source = `from workers import WorkerEntrypoint, Response
import inspect
import markupsafe._speedups as speedups
class Default(WorkerEntrypoint):
    async def fetch(self, request):
        return Response.from_json({'escaped': speedups._escape_inner(await request.text()), 'module': speedups.__file__, 'builtin': inspect.isbuiltin(speedups._escape_inner)})
`;
  local = await startCelld({ 'worker.py': source, 'requirements.txt': requirements, 'celld-python.lock.json': lockText }, {
    main: 'worker.py', no_bundle: false, compatibility_flags: ['python_workers'],
  }, { CELLD_PYTHON_BUILD: join(root, 'build-project.mjs') });
  t.after(local.close);
  for (const input of ['<tag>&', 'plain']) {
    const response = await fetch(local.url, { method: 'POST', body: input, signal: AbortSignal.timeout(10000) });
    const text = await response.text();
    evidence.responses.push({ input, status: response.status, text });
    assert.equal(response.status, 200, text);
    const result = JSON.parse(text);
    assert.equal(result.builtin, true);
    assert.match(result.module, /markupsafe\/_speedups.*\.so$/);
    assert.equal(result.escaped, input === 'plain' ? 'plain' : '&lt;tag&gt;&amp;');
  }
  await writeFile(join(directory, 'worker.py'), source);
  const out = join(directory, '.celld/output');
  await exec(process.execPath, [join(root, 'build-project.mjs'), join(directory, 'worker.py'), out, '[]'], { timeout: 20000 });
  const descriptor = JSON.parse(await readFile(join(out, 'runtime-manifest.json'), 'utf8'));
  assert.equal(descriptor.dynamicLibraries.length, 1);
  assert.match(descriptor.dynamicLibraries[0].path, /markupsafe\/_speedups.*\.so$/);
  evidence.dynamicLibraries = descriptor.dynamicLibraries;
  const files = {
    'index.js': "globalThis.fetch = () => { throw new Error('Extension startup attempted network access'); };\n" + await readFile(join(out, 'index.js'), 'utf8'),
    'pyodide.asm.wasm': await readFile(join(out, 'pyodide.asm.wasm')),
    'sentinel.wasm': await readFile(join(out, 'sentinel.wasm')),
  };
  for (const entry of descriptor.dynamicLibraries) files[entry.module] = await readFile(join(out, entry.module));
  const offline = await startCelld(files, { compatibility_flags: ['python_workers'] });
  t.after(offline.close);
  const response = await fetch(offline.url, { method: 'POST', body: '<offline>', signal: AbortSignal.timeout(10000) });
  const text = await response.text();
  evidence.offline = { status: response.status, text };
  assert.equal(response.status, 200, text);
  assert.equal(JSON.parse(text).escaped, '&lt;offline&gt;');
  assert.equal(JSON.parse(text).builtin, true);
});
