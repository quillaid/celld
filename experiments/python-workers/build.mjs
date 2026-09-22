import { build } from 'esbuild';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('.', import.meta.url)));
await mkdir('dist', { recursive: true });
const runtime = 'node_modules/pyodide/';
await copyFile(`${runtime}pyodide.asm.wasm`, 'dist/pyodide.asm.wasm');
await build({
  entryPoints: ['worker.js'], outfile: 'dist/index.js', bundle: true,
  format: 'esm', platform: 'browser', target: 'es2022',
  external: ['node:*', './pyodide.asm.wasm'],
  loader: { '.zip': 'binary', '.py': 'text' },
  // These definitions affect only this generated fixture, not host globals.
  define: { process: 'undefined', location: '"https://python-runtime.invalid/"' },
  inject: ['./runtime-assets.js'],
});
const files = ['pyodide.mjs', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];
const assets = {};
for (const name of files) {
  const bytes = await readFile(runtime + name);
  assets[name] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
await writeFile('dist/runtime-manifest.json', JSON.stringify({
  pyodide: '0.28.3',
  pythonAbi: JSON.parse(await readFile(runtime + 'pyodide-lock.json', 'utf8')).info,
  packaging: 'fixture-only; stdlib embedded in JS', assets,
}, null, 2) + '\n');
