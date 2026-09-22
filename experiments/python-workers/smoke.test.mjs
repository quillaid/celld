import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const bin = process.env.CELLD_BIN || resolve(root, '../../.celld/tools/celld');
const listen = async (server) => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
};

test('Pyodide through the real celld HTTP, KV, and fetch paths', { timeout: 90000 }, async (t) => {
  await mkdir(resolve(root, '.celld'), { recursive: true });
  const project = await mkdtemp(resolve(root, '.celld/smoke-'));
  for (const name of ['index.js', 'pyodide.asm.wasm']) {
    await copyFile(resolve(root, 'dist', name), resolve(project, name));
  }
  await writeFile(resolve(project, 'wrangler.json'), JSON.stringify({
    name: 'python-workers-smoke', main: 'index.js', no_bundle: true,
    compatibility_date: '2026-09-21',
    kv_namespaces: [{ binding: 'CACHE', id: 'isolated-python-test-cache' }],
  }));
  const echo = createServer((_req, res) => res.end('local outbound fetch succeeded'));
  const echoPort = await listen(echo);
  t.after(() => new Promise((done) => { echo.close(done); echo.closeAllConnections(); }));
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise((done) => reservation.close(done));
  const child = spawn(bin, ['dev', project, '--port', String(port), '--no-watch', '--logs'], {
    stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  let logs = '';
  const stopped = once(child, 'exit');
  // Terminate only this test's process group, including its node child.
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      process.kill(-child.pid, 'SIGTERM');
      let timer;
      await Promise.race([stopped, new Promise((done) => { timer = setTimeout(done, 5000); })]);
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGKILL');
    }
    await stopped;
  });
  t.after(() => rm(project, { recursive: true, force: true }));
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`celld startup timed out\n${logs}`)), 20000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`celld exited ${code}\n${logs}`)); });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => {
      logs += data;
      if (logs.includes('ready  http://')) { clearTimeout(timer); done(); }
    });
  });
  const request = (body) => fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST', body, signal: AbortSignal.timeout(15000),
    headers: { 'x-echo-url': `http://127.0.0.1:${echoPort}/` },
  });
  const sampleNodeMemory = () => {
    if (!['darwin', 'linux'].includes(process.platform)) return null;
    const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' });
    return rows.trim().split('\n').map((row) => row.trim().split(/\s+/).map(Number))
      .filter(([, ppid]) => ppid === child.pid)
      .map(([pid, , rssKiB]) => ({ pid, rssKiB }));
  };
  const measurements = { celld: execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim().split('\n').at(-1),
    pyodide: '0.28.3', timestamp: new Date().toISOString(), platform: process.platform,
    architecture: process.arch, nodeBeforePython: sampleNodeMemory(), warmMs: [] };

  await t.test('concurrent first requests boot Python and import json/sys', async () => {
    const start = performance.now();
    const responses = await Promise.all(Array.from({ length: 4 }, (_, i) => request(`cold-${i}`)));
    measurements.concurrentColdBatchMs = performance.now() - start;
    measurements.coldInterpreterInstances = [...new Set(responses.map((r) => r.headers.get('x-python-instance-id')))];
    for (let i = 0; i < responses.length; i++) {
      const response = responses[i];
      const body = await response.text();
      assert.equal(response.status, 200, body);
      assert.equal(response.headers.get('x-python-initializations'), '1');
      const json = JSON.parse(body);
      assert.equal(json.language, 'python');
      assert.equal(json.body, `cold-${i}`);
      measurements.python = json.version;
    }
  });
  await t.test('Python awaits a real KV write and read', async () => {
    const response = await request('binding');
    const body = await response.text();
    assert.equal(response.status, 200, body);
    assert.equal(JSON.parse(body).binding, 'written from Python');
  });
  await t.test('Python awaits outbound fetch and body consumption', async () => {
    const response = await request('fetch');
    const body = await response.text();
    assert.equal(response.status, 200, body);
    assert.equal(JSON.parse(body).outbound, 'local outbound fetch succeeded');
  });
  await t.test('Python traceback is preserved and a later request works', async () => {
    const response = await request('raise');
    assert.equal(response.status, 500);
    assert.match(await response.text(), /ValueError: intentional Python traceback/);
    assert.equal((await request('after-error')).status, 200);
  });
  await t.test('repeated warm requests preserve their own input', async () => {
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      const response = await request(`warm-${i}`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).body, `warm-${i}`);
      measurements.warmMs.push(performance.now() - start);
    }
  });
  measurements.nodeAfterRequests = sampleNodeMemory();
  await mkdir(resolve(root, 'results'), { recursive: true });
  await writeFile(resolve(root, 'results/smoke.json'), JSON.stringify(measurements, null, 2) + '\n');
  t.diagnostic(JSON.stringify(measurements));
});
