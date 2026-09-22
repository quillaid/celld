import source from './dist/index.js';
import interpreter from './dist/pyodide.asm.wasm';
import sentinel from './dist/sentinel.wasm';

function code() {
  return {
    mainModule: 'index.js', compatibilityDate: '2026-09-21',
    modules: { 'index.js': source, 'pyodide.asm.wasm': { wasm: interpreter }, 'sentinel.wasm': { wasm: sentinel } },
    globalOutbound: null,
  };
}
async function invoke(stub, body, cpuMs = 3000) {
  const response = await stub.getEntrypoint(null, { limits: { cpuMs } }).fetch('https://python.invalid/', { method: 'POST', body });
  return { status: response.status, instance: response.headers.get('x-python-instance-id'),
    linearMemory: Number(response.headers.get('x-python-linear-memory')), body: await response.text() };
}
export default {
  async fetch(request, env) {
    const stub = env.LOADER.load(code());
    try {
      const warm = await invoke(stub, 'warm');
      if (new URL(request.url).pathname === '/memory') {
        const samples = [warm];
        for (let i = 0; i < 100; i++) {
          const result = await invoke(stub, 'allocate');
          if (result.status !== 200) throw new Error(result.body);
          if (i % 10 === 9) samples.push(result);
        }
        return Response.json({ samples });
      }
      let termination;
      const started = Date.now();
      try { termination = await invoke(stub, 'spin', 25); }
      catch (error) { termination = { error: String(error) }; }
      const terminationElapsedMs = Date.now() - started;
      if (new URL(request.url).pathname === '/terminate-only') {
        return Response.json({ warm, termination, terminationElapsedMs });
      }
      const diagnostics = await stub.getEntrypoint(null, { limits: { cpuMs: 1000 } })
        .fetch('https://python.invalid/__diagnostics').then((response) => response.json());
      let after;
      try { after = await Promise.race([
        invoke(stub, 'after-termination', 1000),
        new Promise((done) => setTimeout(() => done({ error: 'post-termination request did not settle within 2000ms' }), 2000)),
      ]); }
      catch (error) { after = { error: String(error) }; }
      const replacement = env.LOADER.load(code());
      try {
        return Response.json({ warm, termination, terminationElapsedMs, diagnostics, after, replacement: await invoke(replacement, 'replacement') });
      } finally { replacement.dispose(); }
    } finally { stub.dispose(); }
  },
};
