import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startCelld } from './local-celld.mjs';
const root = fileURLToPath(new URL('.', import.meta.url));
const exec = promisify(execFile);
test('native Python bundles locked packages, rejects stale inputs and starts offline', { timeout: 90000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'celld-native-packages-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requirements = 'humanize==4.12.3\npython-dateutil==2.9.0.post0\n';
  const source = `from workers import WorkerEntrypoint, Response
import humanize
from dateutil.parser import isoparse
from importlib.metadata import version
class Default(WorkerEntrypoint):
    async def fetch(self, request):
        return Response.from_json({'number': humanize.intcomma(1234567), 'date': isoparse('2026-09-21T12:34:56Z').isoformat(), 'version': version('humanize')})
`;
  await writeFile(join(directory, 'requirements.txt'), requirements);
  await exec(process.execPath, [join(root, 'lock-packages.mjs'), directory], { timeout: 30000 });
  const lockText = await readFile(join(directory, 'celld-python.lock.json'), 'utf8');
  const lock = JSON.parse(lockText);
  const config = { main: 'worker.py', no_bundle: false, compatibility_flags: ['python_workers'] };
  const env = { ...process.env, CELLD_PYTHON_BUILD: join(root, 'build-project.mjs') };
  const local = await startCelld({ 'worker.py': source, 'requirements.txt': requirements, 'celld-python.lock.json': lockText }, config, env);
  t.after(local.close);
  const expected = { number: '1,234,567', date: '2026-09-21T12:34:56+00:00', version: '4.12.3' };
  async function read(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return JSON.parse(text);
  }
  const actual = await read(local.url);
  assert.deepEqual(actual, expected);
  // A nested entry must still resolve the project-root dependency manifest.
  await mkdir(join(directory, 'src'));
  await writeFile(join(directory, 'src/worker.py'), source);
  await writeFile(join(directory, 'wrangler.json'), JSON.stringify({ ...config, name: 'packages', main: 'src/worker.py' }));
  const binary = process.env.CELLD_BIN || resolve(root, '../../target/debug/celld');
  const deploy = (project = directory) => exec(binary, ['deploy', project, '--dry-run', '--json'], { env, timeout: 20000 });
  const versions = [];
  versions.push(JSON.parse((await deploy()).stdout).version);
  versions.push(JSON.parse((await deploy()).stdout).version);
  assert.equal(versions[0], versions[1]);
  const relocated = await mkdtemp(join(tmpdir(), 'celld-relocated-packages-'));
  t.after(() => rm(relocated, { recursive: true, force: true }));
  await cp(directory, relocated, { recursive: true });
  versions.push(JSON.parse((await deploy(relocated)).stdout).version);
  assert.equal(versions[0], versions[2], 'Package deployment identity must not include build-machine paths');
  await writeFile(join(directory, 'requirements.txt'), requirements + '# changed input\n');
  await assert.rejects(deploy(), error => /package lock is stale/.test(error.stderr));
  await writeFile(join(directory, 'requirements.txt'), requirements);
  await writeFile(join(directory, 'celld-python.lock.json'), JSON.stringify({ ...lock, abi: { ...lock.abi, abi_version: 'wrong' } }));
  await assert.rejects(deploy(), error => /target ABI/.test(error.stderr));
  await writeFile(join(directory, 'celld-python.lock.json'), lockText);
  const wheelPath = join(directory, '.celld/python-wheels', lock.packages[0].sha256 + '.whl');
  const wheel = await readFile(wheelPath);
  await writeFile(wheelPath, 'corrupt');
  await assert.rejects(deploy(), error => /artifact hash mismatch/.test(error.stderr));
  await writeFile(wheelPath, wheel);
  const out = join(directory, '.celld/output');
  await exec(process.execPath, [join(root, 'build-project.mjs'), join(directory, 'src/worker.py'), out, '[]'], { env: { ...env, CELLD_PYTHON_PROJECT_ROOT: directory }, timeout: 20000 });
  const descriptor = JSON.parse(await readFile(join(out, 'runtime-manifest.json'), 'utf8'));
  assert.deepEqual(descriptor.packages.lock.packages, lock.packages);
  const offline = await startCelld({
    'index.js': "globalThis.fetch = () => { throw new Error('Offline startup attempted network access'); };\n" + await readFile(join(out, 'index.js'), 'utf8'),
    'pyodide.asm.wasm': await readFile(join(out, 'pyodide.asm.wasm')),
    'sentinel.wasm': await readFile(join(out, 'sentinel.wasm')),
  }, { compatibility_flags: ['python_workers'] });
  t.after(offline.close);
  const offlineResult = await read(offline.url);
  assert.deepEqual(offlineResult, expected);
  await writeFile(join(relocated, 'requirements.txt'), requirements.replace('humanize==4.12.3', 'humanize==4.12.2'));
  await exec(process.execPath, [join(root, 'lock-packages.mjs'), relocated], { timeout: 30000 });
  const changedVersion = JSON.parse((await deploy(relocated)).stdout).version;
  assert.notEqual(changedVersion, versions[0]);
  await mkdir(join(root, 'results'), { recursive: true });
  await writeFile(join(root, 'results/native-packages.json'), JSON.stringify({ timestamp: new Date().toISOString(), actual, offlineResult, versions, changedVersion, descriptor, rejected: ['stale manifest', 'wrong ABI', 'corrupt wheel'], nestedEntry: true }, null, 2) + '\n');
});
