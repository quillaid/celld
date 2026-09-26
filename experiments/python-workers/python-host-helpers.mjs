// Test helpers shared by the python-host tests. Not bundled into Workers.
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { consumePackages } from './consume-packages.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
export const indexURL = resolve(root, 'node_modules/pyodide') + '/';
export const packageRoot = resolve(root, 'fixtures/session-packages');

// Bundle the adapter for Node so its `.py` import becomes text.
export async function bundledAdapter() {
  await mkdir(resolve(root, '.celld'), { recursive: true });
  const outfile = resolve(root, '.celld/python-host.node.mjs');
  await build({
    absWorkingDir: root, entryPoints: ['python-host.js'], bundle: true, outfile,
    format: 'esm', platform: 'node', loader: { '.py': 'text' }, logLevel: 'error',
  });
  return import(pathToFileURL(outfile).href + '?t=' + Date.now());
}

// Names of the Wasm extension modules in a wheel, read from the zip central
// directory. Build-time validation (validate-wheels.py) remains the authority
// for deployments; tests only need the paths.
export function sharedObjects(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error('not a zip archive');
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const names = [];
  for (let i = 0; i < count; i++) {
    const nameLength = view.getUint16(offset + 28, true);
    const extra = view.getUint16(offset + 30, true);
    const comment = view.getUint16(offset + 32, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (name.endsWith('.so')) names.push(name);
    offset += 46 + nameLength + extra + comment;
  }
  return names;
}

export async function lockedPackages() {
  const { artifacts } = await consumePackages(packageRoot);
  const packages = artifacts.map((artifact) => ({
    filename: artifact.filename, kind: artifact.kind || 'wheel',
    sha256: artifact.path.split('/').pop().split('.')[0], bytes: new Uint8Array(artifact.bytes),
  }));
  return { packages, dynamicLibraries: packages.flatMap((item) => sharedObjects(item.bytes)) };
}
