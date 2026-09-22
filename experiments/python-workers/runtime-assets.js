// Fixture-only bridge: use local bundled bytes, never download runtime assets.
import interpreter from './pyodide.asm.wasm';
import stdlib from 'pyodide/python_stdlib.zip';

const wasmResponse = new WeakSet();
// Select Pyodide's worker environment without exposing a global script loader.
// The Emscripten factory is already bundled by worker.js.
export function importScripts(url) {
  throw new Error(`Dynamic runtime scripts are not bundled: ${url}`);
}
export class WorkerGlobalScope {}
export const self = Object.create(globalThis);
Object.defineProperty(self, 'location', { value: { href: 'https://python-runtime.invalid/' } });
export async function fetch(input, init) {
  const url = String(input);
  if (url === 'https://python-runtime.invalid/python_stdlib.zip') {
    return new Response(stdlib);
  }
  if (url === 'https://python-runtime.invalid/pyodide.asm.wasm') {
    const response = new Response(null);
    wasmResponse.add(response);
    return response;
  }
  if (url.startsWith('https://python-runtime.invalid/')) {
    throw new Error(`Runtime asset is not bundled: ${url}`);
  }
  return globalThis.fetch(input, init);
}

// celld provides a compiled-module import, so use its shared code cache.
// The object is lexical to the generated bundle; global WebAssembly is untouched.
export const WebAssembly = Object.create(globalThis.WebAssembly);
// Spike workaround: resolve through the JS microtask queue. Native asynchronous
// Wasm compilation needs a separate celld platform-task-pumping investigation.
WebAssembly.compile = async (bytes) => new globalThis.WebAssembly.Module(bytes);
WebAssembly.instantiate = async (input, imports) => {
  if (input instanceof globalThis.WebAssembly.Module) {
    return new globalThis.WebAssembly.Instance(input, imports);
  }
  const module = new globalThis.WebAssembly.Module(input);
  return { module, instance: new globalThis.WebAssembly.Instance(module, imports) };
};
WebAssembly.instantiateStreaming = async (responsePromise, imports) => {
  const response = await responsePromise;
  if (wasmResponse.has(response)) {
    const instance = new globalThis.WebAssembly.Instance(interpreter, imports);
    return { module: interpreter, instance };
  }
  return WebAssembly.instantiate(await response.arrayBuffer(), imports);
};
