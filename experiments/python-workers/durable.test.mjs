import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { startCelld } from './local-celld.mjs';
import { createServer } from 'node:http';

const root = fileURLToPath(new URL('.', import.meta.url));
test('Python Durable Object SQL and recovery after abort', { timeout: 45000 }, async (t) => {
  const local = await startCelld({
    'index.js': await readFile(resolve(root, 'dist/index.js'), 'utf8'),
    'pyodide.asm.wasm': await readFile(resolve(root, 'dist/pyodide.asm.wasm')),
    'sentinel.wasm': await readFile(resolve(root, 'dist/sentinel.wasm')),
  }, {
    compatibility_flags: ['python_workers'],
    durable_objects: { bindings: [{ name: 'PYTHON_COUNTER', class_name: 'PythonCounter' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['PythonCounter'] }],
  });
  t.after(local.close);
  const evidence = { timestamp: new Date().toISOString(), responses: [] };
  t.after(async () => {
    await mkdir(resolve(root, 'results'), { recursive: true });
    await writeFile(resolve(root, 'results/durable.json'), JSON.stringify(evidence, null, 2) + '\n');
  });
  async function call(name, op, headers) {
    const response = await fetch(`${local.url}/do/${name}/${op}`, { headers, signal: AbortSignal.timeout(8000) });
    const text = await response.text();
    const result = { name, op, status: response.status, interpreter: response.headers.get('x-python-instance-id'), text };
    evidence.responses.push(result);
    return result;
  }
  const first = await call('a', 'inc');
  assert.equal(first.status, 200, first.text);
  assert.equal(JSON.parse(first.text).value, 1);
  const second = await call('a', 'inc');
  assert.equal(second.status, 200, second.text);
  assert.equal(JSON.parse(second.text).value, 2);
  assert.equal(JSON.parse(second.text).objectInstance, JSON.parse(first.text).objectInstance);
  const other = await call('b', 'inc');
  assert.equal(other.status, 200, other.text);
  assert.equal(JSON.parse(other.text).value, 1);
  const aborted = await call('a', 'abort');
  assert.equal(aborted.status, 500, aborted.text);
  assert.match(aborted.text, /intentional Python Durable Object abort/);
  const recovered = await call('a', 'read');
  assert.equal(recovered.status, 200, recovered.text);
  assert.equal(JSON.parse(recovered.text).value, 2);
  assert.notEqual(JSON.parse(recovered.text).objectInstance, JSON.parse(first.text).objectInstance);
  const sibling = await call('b', 'read');
  assert.equal(sibling.status, 200, sibling.text);
  assert.equal(JSON.parse(sibling.text).value, 1);
  assert.equal(sibling.interpreter, recovered.interpreter, 'gate test requires two objects in one interpreter');
  let signalReady;
  const ready = new Promise((done) => { signalReady = done; });
  const server = createServer((_request, response) => { response.end('ready'); signalReady(); });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => server.close(done)));
  let blockSettled = false;
  const blocked = call('a', 'block', { 'x-ready-url': `http://127.0.0.1:${server.address().port}` })
    .catch((error) => ({ error: String(error) }))
    .then((result) => { blockSettled = true; return result; });
  let readyDeadline;
  try {
    await Promise.race([ready, new Promise((_, reject) => {
      readyDeadline = setTimeout(() => reject(new Error('Python block did not start')), 5000);
    })]);
  } finally { clearTimeout(readyDeadline); }
  assert.equal(blockSettled, false, 'Python block must still be waiting when its sibling aborts');
  const interruptedSibling = await call('b', 'abort');
  assert.equal(interruptedSibling.status, 500, interruptedSibling.text);
  const blockResult = await blocked;
  evidence.blockResult = blockResult;
  assert.equal(blockResult.status, 500, JSON.stringify(blockResult));
  const afterBlock = await call('a', 'read');
  assert.equal(afterBlock.status, 200, afterBlock.text);
  assert.equal(JSON.parse(afterBlock.text).value, 2);
  const siblingAfterBlock = await call('b', 'read');
  assert.equal(siblingAfterBlock.status, 200, siblingAfterBlock.text);
  assert.equal(JSON.parse(siblingAfterBlock.text).value, 1);
});
