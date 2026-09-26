// Runs the unchanged celld session bundle (dist/session.js) in pinned workerd
// through Miniflare, to check which parts of the python-host contract hold
// in a workerd Durable Object. A probe that records results, not a gate.
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import workerd from 'workerd';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
process.env.MINIFLARE_WORKERD_PATH = workerd.default;
const modules = [{ type: 'ESModule', path: resolve(dist, 'index.js'), contents: await readFile(resolve(dist, 'session.js'), 'utf8') }];
for (const name of await readdir(dist)) {
  if (name.endsWith('.wasm')) modules.push({ type: 'CompiledWasm', path: resolve(dist, name), contents: await readFile(resolve(dist, name)) });
}
const mf = new Miniflare(convertV4MiniflareOptions({
  modulesRoot: dist, modules, compatibilityDate: '2026-09-21',
  durableObjects: { SESSIONS: { className: 'PythonSession', useSQLite: true } },
}));
const results = { workerd: workerd.version, steps: [] };
const call = async (label, path, body) => {
  const started = Date.now();
  try {
    const response = await mf.dispatchFetch('http://local' + path, { method: body === undefined ? 'GET' : 'POST', body });
    const text = await response.text();
    let json; try { json = JSON.parse(text); } catch {}
    const step = { label, status: response.status, ms: Date.now() - started, json: json && { status: json.status, value: json.value, generation: json.generation, error: json.error?.type ?? json.error, interrupted: json.interrupted, capabilities: json.capabilities, isolate: json.isolate }, text: json ? undefined : text.slice(0, 400) };
    results.steps.push(step);
    return step;
  } catch (error) {
    const step = { label, error: String(error).slice(0, 400), ms: Date.now() - started };
    results.steps.push(step);
    return step;
  }
};
try {
  await mf.ready;
  await call('init', '/s/a/execute', 'x = 41\nx + 1');
  await call('namespace', '/s/a/execute', 'x');
  await call('packages', '/s/a/execute', 'import humanize, markupsafe._speedups as s\n(humanize.intcomma(10**6), s.__file__.endswith(".so"))');
  await call('error', '/s/a/execute', '1/0');
  await call('sql', '/s/a/execute', 'ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS t (v)")\nctx.storage.sql.exec("INSERT INTO t VALUES (1)")\nctx.storage.sql.exec("SELECT count(*) AS n FROM t").one().n');
  const pending = call('suspended', '/s/a/execute', 'import asyncio\nawait asyncio.sleep(60)');
  await new Promise((done) => setTimeout(done, 300));
  await call('interrupt', '/s/a/interrupt', '');
  await pending;
  await call('after-interrupt', '/s/a/execute', 'x');
  await call('info', '/s/a/info');
  await call('b-set', '/s/b/execute', 'y = 3');
  await call('abort-from-python', '/s/a/execute', 'ctx.abort("probe")');
  await call('a-after-abort', '/s/a/execute', '"a alive"');
  await call('b-after-abort', '/s/b/execute', 'y');
} finally {
  await mf.dispose();
}
console.log(JSON.stringify(results, null, 2));
