import { readFile, readdir } from 'node:fs/promises';
import { startCelld } from '../local-celld.mjs';
const d = new URL('../dist/', import.meta.url).pathname;
const files = { 'index.js': await readFile(d + 'session.js', 'utf8') };
for (const n of await readdir(d)) if (n.endsWith('.wasm')) files[n] = await readFile(d + n);
const local = await startCelld(files, { durable_objects: { bindings: [{ name: 'SESSIONS', class_name: 'PythonSession' }] }, migrations: [{ tag: 'v1', new_sqlite_classes: ['PythonSession'] }] });
try {
  for (const n of [100000, 15000]) {
    const t = Date.now();
    try {
      const r = await fetch(local.url + '/probe/async-entries?n=' + n, { signal: AbortSignal.timeout(40000) });
      console.log(JSON.stringify({ n, status: r.status, ms: Date.now() - t, body: (await r.text()).slice(0, 400) }));
    } catch (error) { console.log(JSON.stringify({ n, error: String(error), ms: Date.now() - t })); }
  }
  try {
    const w = await fetch(local.url + '/w/execute', { method: 'POST', body: '1+1', signal: AbortSignal.timeout(20000) });
    console.log(JSON.stringify({ after: w.status, body: (await w.text()).slice(0, 400) }));
  } catch (error) { console.log(JSON.stringify({ after: String(error) })); }
} finally {
  console.log('--- celld log tail');
  console.log(local.logs().split('\n').filter((l) => l.length < 600).slice(-25).join('\n'));
  await local.close();
}
