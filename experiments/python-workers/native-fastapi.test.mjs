import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import workerd from 'workerd';
import { consumePackages } from './consume-packages.mjs';
import { startCelld } from './local-celld.mjs';
const root = fileURLToPath(new URL('.', import.meta.url));
const exec = promisify(execFile);
async function observe(send, path, init) {
  const deadline = Date.now() + 5000;
  while (true) {
    const response = await send(path, init);
    const result = { status: response.status, text: await response.text() };
    if (path.startsWith('/background/') && !init.method && result.status === 200 && JSON.parse(result.text).state === 'pending') {
      assert.ok(Date.now() < deadline, 'Synchronous framework background task did not complete');
      await new Promise(resolve => setTimeout(resolve, 25));
      continue;
    }
    return result;
  }
}
test('FastAPI validation and compiled Pydantic/OpenSSL match pinned workerd', { timeout: 90000 }, async (t) => {
  const files = {};
  for (const name of ['worker.py', 'requirements.txt', 'celld-python.lock.json']) files[name] = await readFile(join(root, 'fastapi', name), 'utf8');
  const evidence = { timestamp: new Date().toISOString(), workerd: workerd.version, referenceDate: '2025-06-01', responses: [] };
  let local;
  t.after(async () => {
    await mkdir(join(root, 'results'), { recursive: true });
    await writeFile(join(root, 'results/native-fastapi.json'), JSON.stringify({ ...evidence, logs: local?.logs() }, null, 2) + '\n');
  });
  local = await startCelld(files, { main: 'worker.py', no_bundle: false, compatibility_flags: ['python_workers'] }, { CELLD_PYTHON_BUILD: join(root, 'build-project.mjs') });
  t.after(local.close);
  const cases = [
    ['/sync/11', undefined, 200, { value: 22, on_main_thread: true }],
    ['/background/9', {}, 200, { accepted: 9 }],
    ['/background/9', undefined, 200, { state: 'complete' }],
    ['/items/7?scale=2', { name: 'café', count: '3' }, 201, { id: 7, item: { name: 'café', count: 3 }, total: 6 }],
    ['/items/7', { name: 'bad', count: 0 }, 422],
    ['/items/no', { name: 'bad', count: 2 }, 422],
    ['/items/7?scale=no', { name: 'bad', count: 2 }, 422],
    ['/runtime', undefined, 200],
    ['/openapi.json', undefined, 200],
  ];
  for (const [path, body, status, expected] of cases) {
    const init = body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
    const actual = await observe((path, init) => fetch(local.url + path, { ...init, signal: AbortSignal.timeout(20000) }), path, init);
    evidence.responses.push({ path, init, actual });
    assert.equal(actual.status, status, actual.text);
    if (expected) assert.deepEqual(JSON.parse(actual.text), expected);
  }
  await local.close();
  const output = await mkdtemp(join(tmpdir(), 'celld-fastapi-offline-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  await exec(process.execPath, [join(root, 'build-project.mjs'), join(root, 'fastapi/worker.py'), output, '[]'], { timeout: 20000 });
  const descriptor = JSON.parse(await readFile(join(output, 'runtime-manifest.json'), 'utf8'));
  evidence.dynamicLibraries = descriptor.dynamicLibraries;
  assert.ok(descriptor.dynamicLibraries.find(item => item.path === 'libcrypto.so'));
  assert.ok(descriptor.dynamicLibraries.find(item => item.path === 'libssl.so'));
  const offlineFiles = { 'index.js': "globalThis.fetch = () => { throw new Error('FastAPI startup attempted network access'); };\n" + await readFile(join(output, 'index.js'), 'utf8') };
  for (const name of ['pyodide.asm.wasm', 'sentinel.wasm', ...descriptor.dynamicLibraries.map(item => item.module)]) offlineFiles[name] = await readFile(join(output, name));
  const offline = await startCelld(offlineFiles, { compatibility_flags: ['python_workers'] });
  t.after(offline.close);
  for (const observation of evidence.responses) {
    observation.offline = await observe((path, init) => fetch(offline.url + path, { ...init, signal: AbortSignal.timeout(10000) }), observation.path, observation.init);
    assert.deepEqual(observation.offline, observation.actual);
  }
  await offline.close();
  const consumed = await consumePackages(join(root, 'fastapi'));
  const modules = [];
  function mount(path, accept = () => true) {
    const names = execFileSync('unzip', ['-Z1', path], { encoding: 'utf8' }).trim().split('\n');
    for (const name of names.filter(name => !name.endsWith('/') && accept(name))) modules.push({ type: 'Data', path: join(root, 'python_modules', name), contents: execFileSync('unzip', ['-p', path, name], { maxBuffer: 32 * 1024 * 1024 }) });
  }
  mount(join(root, '.celld/workers_runtime_sdk-1.9.0-py3-none-any.whl'), name => (name.startsWith('workers/') && name.endsWith('.py')) || name === '_workers_sdk_package_patches.py');
  for (const artifact of consumed.artifacts) mount(artifact.path);
  const core = modules.find(item => /pydantic_core\/.*\.so$/.test(item.path));
  assert.ok(core);
  const runtime = JSON.parse(evidence.responses.find(item => item.path === '/runtime').actual.text);
  assert.equal(runtime.core_sha256, createHash('sha256').update(core.contents).digest('hex'));
  assert.equal(runtime.ssl_sha256, descriptor.dynamicLibraries.find(item => item.path === '_ssl.so').sha256);
  assert.equal(runtime.verify_mode, 2);
  assert.equal(runtime.check_hostname, true);
  assert.equal(runtime.thread_patch, '_workers_sdk_package_patches');
  const sdkPatch = modules.find(item => item.path.endsWith('/_workers_sdk_package_patches.py'));
  assert.equal(runtime.patch_sha256, createHash('sha256').update(sdkPatch.contents).digest('hex'));
  const previous = process.env.MINIFLARE_WORKERD_PATH;
  process.env.MINIFLARE_WORKERD_PATH = workerd.default;
  t.after(() => { if (previous === undefined) delete process.env.MINIFLARE_WORKERD_PATH; else process.env.MINIFLARE_WORKERD_PATH = previous; });
  // Historical workerd eagerly imports its own SSL wheel. Remove those module
  // cache entries so this application imports the mounted target wheel instead.
  // The digest assertion below must catch accidental use of the bundled copy.
  const bootstrap = "import sys, os\nsys.path.insert(0, '/session/metadata/python_modules')\nos.environ['LD_LIBRARY_PATH'] = '/session/metadata/python_modules:' + os.environ.get('LD_LIBRARY_PATH', '')\nsys.modules.pop('ssl', None)\nsys.modules.pop('_ssl', None)\n";
  const patchBootstrap = "sys.modules.pop('_workers_sdk_package_patches', None)\nimport _workers_sdk_package_patches\nfrom _cloudflare.import_patch_manager import PatchFinder\n_reference_finder = PatchFinder()\nsys.meta_path.insert(0, _reference_finder)\ntry:\n";
  const application = files['worker.py'].split('\n').map(line => '    ' + line).join('\n');
  const reference = new Miniflare(convertV4MiniflareOptions({ name: 'fastapi-reference', cf: false, modulesRoot: root, compatibilityDate: '2025-06-01', compatibilityFlags: ['python_workers', 'python_workers_20250116'], modules: [{ type: 'PythonModule', path: join(root, 'fastapi-reference.py'), contents: bootstrap + patchBootstrap + application + '\nfinally:\n    sys.meta_path.remove(_reference_finder)\nDefault.on_fetch = Default.fetch\n' }, ...modules] }));
  t.after(() => reference.dispose());
  for (const observation of evidence.responses) {
    observation.expected = await observe((path, init) => reference.dispatchFetch('http://local' + path, init), observation.path, observation.init);
    assert.equal(observation.actual.status, observation.expected.status, observation.expected.text);
    assert.deepEqual(JSON.parse(observation.actual.text), JSON.parse(observation.expected.text));
  }
});
