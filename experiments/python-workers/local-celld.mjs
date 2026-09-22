import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

// Small real-server harness for runtime probes. Files and storage belong only
// to this invocation; cleanup never targets another celld process.
export async function startCelld(files, config = {}, environment = {}) {
  await mkdir(resolve(root, '.celld'), { recursive: true });
  const project = await mkdtemp(resolve(root, '.celld/probe-'));
  let child, stopped, logs = '', closing;
  const signal = (name) => {
    if (!child?.pid) return;
    try { process.kill(-child.pid, name); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const close = () => closing ??= (async () => {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      signal('SIGTERM');
      let timer;
      await Promise.race([stopped, new Promise((done) => { timer = setTimeout(done, 5000); })]);
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) signal('SIGKILL');
      await stopped;
    }
    await rm(project, { recursive: true, force: true });
  })();
  try {
    for (const [name, contents] of Object.entries(files)) await writeFile(resolve(project, name), contents);
    await writeFile(resolve(project, 'wrangler.json'), JSON.stringify({
      name: 'python-runtime-probe', main: 'index.js', no_bundle: true,
      compatibility_date: '2026-09-21', ...config,
    }));
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise((done) => reservation.close(done));
    const bin = process.env.CELLD_BIN || resolve(root, '../../.celld/tools/celld');
    child = spawn(bin, ['dev', project, '--port', String(port), '--no-watch', '--logs'], {
      detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...environment },
    });
    stopped = new Promise((done) => { child.once('exit', done); child.once('error', done); });
    await new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new Error(`startup timeout\n${logs}`)), 20000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`celld exited ${code}\n${logs}`)); });
      for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => {
        logs += data;
        if (logs.includes('ready  http://')) { clearTimeout(timer); done(); }
      });
    });
    return { url: `http://127.0.0.1:${port}`, pid: child.pid, close, logs: () => logs };
  } catch (error) {
    await close();
    throw error;
  }
}
