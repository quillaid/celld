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
test('locked package application and released SDK match the workerd reference', { timeout: 40000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'celld-package-reference-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requirements = 'humanize==4.12.3\npython-dateutil==2.9.0.post0\n';
  await writeFile(join(directory, 'requirements.txt'), requirements);
  await exec(process.execPath, [join(root, 'lock-packages.mjs'), directory], { timeout: 20000 });
  const lockText = await readFile(join(directory, 'celld-python.lock.json'), 'utf8');
  const lock = JSON.parse(lockText);
  const source = `from workers import WorkerEntrypoint, Response
import workers.entrypoints
import hashlib
import humanize
from dateutil.parser import isoparse
from importlib.metadata import version
class Default(WorkerEntrypoint):
    async def fetch(self, request):
        with open(workers.entrypoints.__file__, 'rb') as source:
            sdk_hash = hashlib.sha256(source.read()).hexdigest()
        return Response.from_json({'number': humanize.intcomma(int(await request.text())), 'date': isoparse('2026-09-21T12:34:56Z').isoformat(), 'versions': [version(name) for name in ['humanize', 'python-dateutil', 'six']], 'sdk_hash': sdk_hash})
`;
  const local = await startCelld({ 'worker.py': source, 'requirements.txt': requirements, 'celld-python.lock.json': lockText }, {
    main: 'worker.py', no_bundle: false, compatibility_flags: ['python_workers'],
  }, { CELLD_PYTHON_BUILD: join(root, 'build-project.mjs') });
  t.after(local.close);
  const wheel = join(root, '.celld/workers_runtime_sdk-1.9.0-py3-none-any.whl');
  const entries = execFileSync('unzip', ['-Z1', wheel], { encoding: 'utf8' }).trim().split('\n');
  const modules = entries.filter(name => name.startsWith('workers/') && name.endsWith('.py')).map(name => ({
    type: 'Data', path: join(root, 'python_modules', name), contents: execFileSync('unzip', ['-p', wheel, name]),
  }));
  const expectedSdkHash = createHash('sha256').update(execFileSync('unzip', ['-p', wheel, 'workers/entrypoints.py'])).digest('hex');
  const mountedWheels = [];
  for (const entry of lock.packages) {
    const bytes = await readFile(join(directory, '.celld/python-wheels', entry.sha256 + '.whl'));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
    modules.push({ type: 'Data', path: join(root, 'python_modules', entry.filename), contents: bytes });
    mountedWheels.push('/session/metadata/python_modules/' + entry.filename);
  }
  const previous = process.env.MINIFLARE_WORKERD_PATH;
  process.env.MINIFLARE_WORKERD_PATH = workerd.default;
  t.after(() => { if (previous === undefined) delete process.env.MINIFLARE_WORKERD_PATH; else process.env.MINIFLARE_WORKERD_PATH = previous; });
  const reference = new Miniflare(convertV4MiniflareOptions({
    name: 'package-reference', cf: false, modulesRoot: root,
    compatibilityDate: '2025-06-01', compatibilityFlags: ['python_workers', 'python_workers_20250116'],
    modules: [{ type: 'PythonModule', path: join(root, 'package-reference.py'), contents: `import sys\nsys.path[:0] = ${JSON.stringify(['/session/metadata/python_modules', ...mountedWheels])}\n` + source + '\nDefault.on_fetch = Default.fetch\n' }, ...modules],
  }));
  t.after(() => reference.dispose());
  const evidence = { timestamp: new Date().toISOString(), reference: { workerd: workerd.version, compatibilityDate: '2025-06-01', adapter: 'Historical on_fetch alias; unchanged SDK files; same locked pure wheels on sys.path' }, lock, responses: [] };
  t.after(async () => {
    await mkdir(join(root, 'results'), { recursive: true });
    await writeFile(join(root, 'results/package-reference.json'), JSON.stringify(evidence, null, 2) + '\n');
  });
  for (const input of ['1234567', '-9876543']) {
    const response = await fetch(local.url, { method: 'POST', body: input, signal: AbortSignal.timeout(10000) });
    const actual = { status: response.status, text: await response.text() };
    const expectedResponse = await reference.dispatchFetch('http://local/', { method: 'POST', body: input });
    const expected = { status: expectedResponse.status, text: await expectedResponse.text() };
    evidence.responses.push({ input, actual, expected });
    assert.equal(actual.status, 200, actual.text);
    assert.equal(expected.status, 200, expected.text);
    assert.deepEqual(JSON.parse(actual.text), JSON.parse(expected.text));
    assert.equal(JSON.parse(actual.text).sdk_hash, expectedSdkHash);
    assert.deepEqual(JSON.parse(actual.text).versions, ['4.12.3', '2.9.0.post0', '1.17.0']);
  }
});
