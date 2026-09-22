import source from './dist/index.js';
import interpreter from './dist/pyodide.asm.wasm';
import sentinel from './dist/sentinel.wasm';

function code() {
  return {
    mainModule: 'index.js', compatibilityDate: '2026-09-21', compatibilityFlags: ['python_workers'],
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
      const pending = invoke(stub, 'delay').catch((error) => ({ error: String(error) }));
      let pendingStarted = false;
      for (let i = 0; i < 50; i++) {
        const status = await stub.getEntrypoint().fetch('https://python.invalid/__diagnostics').then((response) => response.json());
        if (status.delayStarted) { pendingStarted = true; break; }
        await new Promise((done) => setTimeout(done, 10));
      }
      if (!pendingStarted) throw new Error('Python delay did not start before the termination probe');
      let termination;
      const started = Date.now();
      try { termination = await invoke(stub, 'spin', 25); }
      catch (error) { termination = { error: String(error) }; }
      const terminationElapsedMs = Date.now() - started;
      const pendingResult = await Promise.race([
        pending,
        new Promise((done) => setTimeout(() => done({ error: 'suspended request did not wake after invalidation within 2000ms' }), 2000)),
      ]);
      const pendingElapsedMs = Date.now() - started;
      if (new URL(request.url).pathname === '/terminate-only') {
        return Response.json({ warm, termination, terminationElapsedMs, pendingStarted, pendingElapsedMs, pending: pendingResult });
      }
      let diagnostics;
      try {
        diagnostics = await stub.getEntrypoint(null, { limits: { cpuMs: 1000 } })
          .fetch('https://python.invalid/__diagnostics').then((response) => response.json());
      } catch (error) { diagnostics = { error: String(error) }; }
      let after;
      try { after = await Promise.race([
        invoke(stub, 'after-termination', 1000),
        new Promise((done) => setTimeout(() => done({ error: 'post-termination request did not settle within 2000ms' }), 2000)),
      ]); }
      catch (error) { after = { error: String(error) }; }
      const secondAfter = await invoke(stub, 'second-after-termination').catch((error) => ({ error: String(error) }));
      const replacement = env.LOADER.load(code());
      try {
        return Response.json({ warm, termination, terminationElapsedMs, diagnostics, after, secondAfter, pendingStarted, pendingElapsedMs, pending: pendingResult, replacement: await invoke(replacement, 'replacement') });
      } finally { replacement.dispose(); }
    } finally { stub.dispose(); }
  },
};
