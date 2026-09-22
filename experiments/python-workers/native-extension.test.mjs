import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import workerd from 'workerd';
import { startCelld } from './local-celld.mjs';
const root = fileURLToPath(new URL('.', import.meta.url));
const exec = promisify(execFile);
test('compiled MarkupSafe executes offline and matches the same extension on workerd', { timeout: 60000 }, async (t) => {
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
import hashlib
import workers.entrypoints
import markupsafe._speedups as speedups
def digest(path):
    with open(path, 'rb') as source:
        return hashlib.sha256(source.read()).hexdigest()
class Default(WorkerEntrypoint):
    async def fetch(self, request):
        return Response.from_json({'escaped': speedups._escape_inner(await request.text()), 'module': speedups.__file__, 'builtin': inspect.isbuiltin(speedups._escape_inner), 'extension_sha256': digest(speedups.__file__), 'sdk_sha256': digest(workers.entrypoints.__file__)})
`;
  local = await startCelld({ 'worker.py': source, 'requirements.txt': requirements, 'celld-python.lock.json': lockText }, {
    main: 'worker.py', no_bundle: false, compatibility_flags: ['python_workers'],
  }, { CELLD_PYTHON_BUILD: join(root, 'build-project.mjs') });
  t.after(local.close);
  const cases = [['<tag>&', '&lt;tag&gt;&amp;'], ['plain', 'plain'], ['<snowman>☃&', '&lt;snowman&gt;☃&amp;'], ['😀<&', '😀&lt;&amp;']];
  for (const [input, escaped] of cases) {
    const response = await fetch(local.url, { method: 'POST', body: input, signal: AbortSignal.timeout(10000) });
    const text = await response.text();
    evidence.responses.push({ input, status: response.status, text });
    assert.equal(response.status, 200, text);
    const result = JSON.parse(text);
    assert.equal(result.builtin, true);
    assert.match(result.module, /markupsafe\/_speedups.*\.so$/);
    assert.equal(result.escaped, escaped);
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
  await offline.close();
  await local.close();
  const sdkWheel = join(root, '.celld/workers_runtime_sdk-1.9.0-py3-none-any.whl');
  const sdkHash = createHash('sha256').update(execFileSync('unzip', ['-p', sdkWheel, 'workers/entrypoints.py'])).digest('hex');
  const modules = [];
  function mountWheel(wheelPath, accept) {
    const names = execFileSync('unzip', ['-Z1', wheelPath], { encoding: 'utf8' }).trim().split('\n');
    for (const name of names.filter(name => !name.endsWith('/') && accept(name))) {
      modules.push({ type: 'Data', path: join(root, 'python_modules', name), contents: execFileSync('unzip', ['-p', wheelPath, name]) });
    }
  }
  mountWheel(sdkWheel, name => name.startsWith('workers/') && name.endsWith('.py'));
  for (const entry of evidence.lock.packages) {
    const path = join(directory, '.celld/python-wheels', entry.sha256 + '.whl');
    assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), entry.sha256);
    mountWheel(path, () => true);
  }
  const previous = process.env.MINIFLARE_WORKERD_PATH;
  process.env.MINIFLARE_WORKERD_PATH = workerd.default;
  t.after(() => { if (previous === undefined) delete process.env.MINIFLARE_WORKERD_PATH; else process.env.MINIFLARE_WORKERD_PATH = previous; });
  const reference = new Miniflare(convertV4MiniflareOptions({
    name: 'extension-reference', cf: false, modulesRoot: root,
    compatibilityDate: '2025-06-01', compatibilityFlags: ['python_workers', 'python_workers_20250116'],
    modules: [{ type: 'PythonModule', path: join(root, 'extension-reference.py'), contents: "import sys\nsys.path.insert(0, '/session/metadata/python_modules')\n" + source + '\nDefault.on_fetch = Default.fetch\n' }, ...modules],
  }));
  t.after(() => reference.dispose());
  evidence.reference = { workerd: workerd.version, compatibilityDate: '2025-06-01', adapter: 'Historical on_fetch alias; unchanged SDK; wheel contents mounted as read-only Worker Data modules', responses: [] };
  for (const actual of evidence.responses) {
    const response = await reference.dispatchFetch('http://local/', { method: 'POST', body: actual.input });
    const text = await response.text();
    evidence.reference.responses.push({ input: actual.input, status: response.status, text });
    assert.equal(response.status, 200, text);
    const { module: expectedPath, ...expected } = JSON.parse(text);
    const { module: actualPath, ...result } = JSON.parse(actual.text);
    assert.match(expectedPath, /markupsafe\/_speedups.*\.so$/);
    assert.match(actualPath, /markupsafe\/_speedups.*\.so$/);
    assert.deepEqual(result, expected);
    assert.equal(result.sdk_sha256, sdkHash);
    assert.equal(result.extension_sha256, descriptor.dynamicLibraries[0].sha256);
  }
});
