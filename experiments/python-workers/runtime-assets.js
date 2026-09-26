// Fixture-only bridge: use local bundled bytes, never download runtime assets.
import interpreter from './pyodide.asm.wasm';
import sentinel from './sentinel.wasm';
import sentinelBytes from 'pyodide-sentinel-bytes';
import stdlib from 'pyodide/python_stdlib.zip';
import { artifacts as dynamicLibraries } from 'celld-python-dylibs';

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
// The async compiler bridge only accepts the pinned sentinel and emitted wheel
// libraries. Every match returns an immutable compiled-module import.
WebAssembly.compile = async (input) => {
  const bytes = ArrayBuffer.isView(input)
    ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
  if (bytes.length === sentinelBytes.length && bytes.every((byte, i) => byte === sentinelBytes[i])) return sentinel;
  for (const artifact of dynamicLibraries) {
    if (bytes.length === artifact.bytes.length && bytes.every((byte, i) => byte === artifact.bytes[i])) return artifact.module;
  }
  throw new globalThis.WebAssembly.CompileError('Python runtime requested an unbundled Wasm module');
};
WebAssembly.instantiate = async (input, imports) => {
  if (input instanceof globalThis.WebAssembly.Module) {
    return globalThis.WebAssembly.instantiate(input, imports);
  }
  const module = await WebAssembly.compile(input);
  return { module, instance: await globalThis.WebAssembly.instantiate(module, imports) };
};
WebAssembly.instantiateStreaming = async (responsePromise, imports) => {
  const response = await responsePromise;
  if (wasmResponse.has(response)) {
    const instance = await globalThis.WebAssembly.instantiate(interpreter, imports);
    return { module: interpreter, instance };
  }
  return WebAssembly.instantiate(await response.arrayBuffer(), imports);
};
