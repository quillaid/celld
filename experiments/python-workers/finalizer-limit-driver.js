import { DurableObject } from 'cloudflare:workers';
import source from 'python-source';
import interpreter from 'python-wasm';
import sentinel from 'python-sentinel';
function code() {
  return { mainModule: 'index.js', compatibilityDate: '2026-09-21', compatibilityFlags: ['python_workers'],
    modules: { 'index.js': source, 'pyodide.asm.wasm': { wasm: interpreter }, 'sentinel.wasm': { wasm: sentinel } },
    globalOutbound: null, limits: { cpuMs: 3000 } };
}
export default { fetch(request, env) { return env.PARENT.getByName('finalizer').fetch(request); } };
export class Parent extends DurableObject {
  async fetch() {
    let loaded = this.env.LOADER.load(code());
    const facet = name => this.ctx.facets.get(name, () => ({ class: loaded.getDurableObjectClass('Counter') }));
    const call = async (name, body) => {
      const response = await facet(name).fetch('http://python/', { method: 'POST', body });
      const text = await response.text();
      if (response.status !== 200) throw new Error(text);
      return JSON.parse(text);
    };
    try {
      const witness = await call('witness', 'write');
      const controlBefore = await call('victim', 'read');
      this.ctx.facets.abort('victim', 'normal finalizer control');
      const controlAfter = await call('victim', 'read');
      const armed = await call('victim', 'arm');
      this.ctx.facets.abort('victim', 'retire armed finalizer');
      const started = Date.now();
      let failure;
      try { await call('victim', 'read'); }
      catch (error) { failure = String(error); }
      const elapsedMs = Date.now() - started;
      let afterTermination;
      try { afterTermination = await call('witness', 'read'); }
      catch (error) { afterTermination = String(error); }
      this.ctx.facets.abort('victim', 'replace invalidated interpreter');
      this.ctx.facets.abort('witness', 'replace invalidated interpreter');
      loaded.dispose();
      loaded = this.env.LOADER.load(code());
      const replacement = await call('witness', 'read');
      return Response.json({ witness, controlBefore, controlAfter, armed, failure, elapsedMs, afterTermination, replacement });
    } finally { loaded.dispose(); }
  }
}
