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
test('Python package reload retains the last good worker across stale and invalid locks', { timeout: 60000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'celld-package-reload-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const variants = [];
  for (const version of ['4.12.3', '4.12.2']) {
    const requirements = `humanize==${version}\n`;
    await writeFile(join(directory, 'requirements.txt'), requirements);
    await exec(process.execPath, [join(root, 'lock-packages.mjs'), directory], { timeout: 20000 });
    variants.push({ version, requirements, lock: await readFile(join(directory, 'celld-python.lock.json'), 'utf8') });
  }
  const local = await startCelld({
    'worker.py': `from workers import WorkerEntrypoint, Response
import humanize
from importlib.metadata import version
class Default(WorkerEntrypoint):
    async def fetch(self, request):
        return Response.from_json({'version': version('humanize'), 'formatted': humanize.intcomma(1234567)})
`,
    'requirements.txt': variants[0].requirements,
    'celld-python.lock.json': variants[0].lock,
  }, { main: 'worker.py', no_bundle: false, compatibility_flags: ['python_workers'] }, {
    CELLD_PYTHON_BUILD: join(root, 'build-project.mjs'),
  }, { watch: true });
  t.after(local.close);
  const evidence = { timestamp: new Date().toISOString(), observations: [] };
  t.after(async () => {
    await mkdir(join(root, 'results'), { recursive: true });
    await writeFile(join(root, 'results/package-reload.json'), JSON.stringify({ ...evidence, logs: local.logs() }, null, 2) + '\n');
  });
  async function expectVersion(stage, version) {
    const response = await fetch(local.url, { headers: { connection: 'close' }, signal: AbortSignal.timeout(10000) });
    const text = await response.text();
    evidence.observations.push({ stage, status: response.status, text });
    assert.equal(response.status, 200, text);
    assert.deepEqual(JSON.parse(text), { version, formatted: '1,234,567' });
  }
  async function waitLog(offset, message) {
    const deadline = Date.now() + 20000;
    do {
      if (local.logs().slice(offset).includes(message)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.fail(`Missing ${message}\n${local.logs()}`);
  }
  await expectVersion('initial', variants[0].version);
  let offset = local.logs().length;
  await local.write('requirements.txt', variants[1].requirements);
  await waitLog(offset, 'package lock is stale');
  await expectVersion('stale-lock', variants[0].version);
  offset = local.logs().length;
  const invalid = JSON.parse(variants[1].lock);
  invalid.abi.abi_version = 'wrong';
  await local.write('celld-python.lock.json', JSON.stringify(invalid));
  await waitLog(offset, 'target ABI');
  await expectVersion('invalid-lock', variants[0].version);
  offset = local.logs().length;
  await local.write('celld-python.lock.json', variants[1].lock);
  await waitLog(offset, 'ready  http://');
  await expectVersion('updated-package', variants[1].version);
  offset = local.logs().length;
  await local.write('requirements.txt', variants[0].requirements);
  await waitLog(offset, 'package lock is stale');
  await expectVersion('stale-revert', variants[1].version);
  offset = local.logs().length;
  await local.write('celld-python.lock.json', variants[0].lock);
  await waitLog(offset, 'ready  http://');
  await expectVersion('restored-package', variants[0].version);
});
