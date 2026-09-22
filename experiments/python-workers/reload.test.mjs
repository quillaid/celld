import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { startCelld } from './local-celld.mjs';
const root = new URL('.', import.meta.url);
test('Python watch reload retains the last good deployment after a syntax error', { timeout: 60000 }, async (t) => {
  const local = await startCelld({
    'worker.py': 'from workers import WorkerEntrypoint, Response\nfrom greeting import value\nclass Default(WorkerEntrypoint):\n    async def fetch(self, request):\n        return Response(value)\n',
    'greeting.py': 'value = "first"\n',
  }, { main: 'worker.py', no_bundle: false, compatibility_flags: ['python_workers'] }, {
    CELLD_PYTHON_BUILD: fileURLToPath(new URL('build-project.mjs', root)),
  }, { watch: true });
  t.after(local.close);
  const evidence = { timestamp: new Date().toISOString(), observations: [] };
  t.after(async () => {
    await mkdir(new URL('results/', root), { recursive: true });
    await writeFile(new URL('results/reload.json', root), JSON.stringify({ ...evidence, logs: local.logs() }, null, 2) + '\n');
  });
  async function read() {
    const response = await fetch(local.url, { headers: { connection: 'close' }, signal: AbortSignal.timeout(10000) });
    const text = await response.text();
    evidence.observations.push({ status: response.status, text });
    assert.equal(response.status, 200, text);
    return text;
  }
  async function eventually(predicate, description) {
    const deadline = Date.now() + 20000;
    do {
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.fail(description + '\n' + local.logs());
  }
  assert.equal(await read(), 'first');
  const firstReload = local.logs().length;
  await local.write('greeting.py', 'value = "second"\n');
  await eventually(() => local.logs().slice(firstReload).includes('ready  http://'), 'source reload did not become ready');
  assert.equal(await read(), 'second');
  const logStart = local.logs().length;
  await local.write('greeting.py', 'value = (\n');
  await eventually(() => local.logs().slice(logStart).includes('SyntaxError'), 'broken edit did not fail compilation');
  assert.equal(await read(), 'second');
  const recovery = local.logs().length;
  await local.write('greeting.py', 'value = "third"\n');
  await eventually(() => local.logs().slice(recovery).includes('ready  http://'), 'valid edit after failure did not become ready');
  assert.equal(await read(), 'third');
});
