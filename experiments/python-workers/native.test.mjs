import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { startCelld } from './local-celld.mjs';
const root = new URL('.', import.meta.url);
test('native .py project builds and serves SDK HTTP through celld dev', { timeout: 30000 }, async (t) => {
  const local = await startCelld({
    'worker.py': `from workers import WorkerEntrypoint, Response\nfrom greeting import greeting\nclass Default(WorkerEntrypoint):\n    async def fetch(self, request):\n        return Response.from_json({'message': greeting(await request.text())}, status=201)\n`,
    'greeting.py': `def greeting(name):\n    return 'hello ' + name\n`,
  }, { main: 'worker.py', no_bundle: false, compatibility_flags: ['python_workers'] }, {
    CELLD_PYTHON_BUILD: fileURLToPath(new URL('build-project.mjs', root)),
  });
  t.after(local.close);
  const response = await fetch(local.url, { method: 'POST', body: 'native Python', signal: AbortSignal.timeout(10000) });
  const result = { timestamp: new Date().toISOString(), status: response.status, text: await response.text() };
  await mkdir(new URL('results/', root), { recursive: true });
  await writeFile(new URL('results/native.json', root), JSON.stringify(result, null, 2) + '\n');
  assert.equal(response.status, 201, result.text);
  assert.deepEqual(JSON.parse(result.text), { message: 'hello native Python' });
});

test('native Python deployment identity is reproducible and rejects unsupported configuration', { timeout: 60000 }, async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join, resolve } = await import('node:path');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);
  const directories = await Promise.all([0, 1].map(() => mkdtemp(join(tmpdir(), 'celld-python-build-'))));
  t.after(() => Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true }))));
  const config = { name: 'python-native-build', main: 'worker.py', compatibility_flags: ['python_workers'] };
  const source = 'from workers import WorkerEntrypoint, Response\nclass Default(WorkerEntrypoint):\n    async def fetch(self, request):\n        return Response("native")\n';
  const env = { ...process.env, CELLD_PYTHON_BUILD: fileURLToPath(new URL('build-project.mjs', root)) };
  const binary = process.env.CELLD_BIN || resolve(fileURLToPath(root), '../../target/debug/celld');
  async function deploy(directory) {
    return exec(binary, ['deploy', directory, '--dry-run', '--json'], { env, timeout: 20000 });
  }
  const versions = [];
  for (const directory of directories) {
    await writeFile(join(directory, 'wrangler.json'), JSON.stringify(config));
    await writeFile(join(directory, 'worker.py'), source);
    versions.push(JSON.parse((await deploy(directory)).stdout).version);
  }
  assert.equal(typeof versions[0], 'string');
  assert.equal(versions[0], versions[1]);
  await writeFile(join(directories[1], 'worker.py'), source.replace('native', 'changed'));
  const changed = JSON.parse((await deploy(directories[1])).stdout).version;
  assert.notEqual(changed, versions[0]);
  await writeFile(join(directories[1], 'worker.py'), source + '\nraise RuntimeError("do not execute application at build time")\n');
  await deploy(directories[1]);
  await writeFile(join(directories[1], 'worker.py'), source + '\ninvalid = (\n');
  await assert.rejects(deploy(directories[1]), error => /SyntaxError/.test(error.stderr) && /worker\.py/.test(error.stderr) && !/var Module=moduleArg/.test(error.stderr));
  await writeFile(join(directories[0], 'pyproject.toml'), '[project]\nname="example"\ndependencies=["requests"]\n');
  await assert.rejects(deploy(directories[0]), error => /pending package resolver/.test(error.stderr));
  await rm(join(directories[0], 'pyproject.toml'));
  await writeFile(join(directories[0], 'wrangler.json'), JSON.stringify({ ...config, no_bundle: true }));
  await assert.rejects(deploy(directories[0]), error => /do not support no_bundle/.test(error.stderr));
  await writeFile(new URL('results/native-identity.json', root), JSON.stringify({ timestamp: new Date().toISOString(), versions, changed, compileWithoutExecution: true, rejected: ['syntax error', 'dependency manifest', 'no_bundle'] }, null, 2) + '\n');
});
