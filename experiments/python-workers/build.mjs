import { build } from 'esbuild';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('.', import.meta.url)));
await mkdir('dist', { recursive: true });
const runtime = 'node_modules/pyodide/';
// Pyodide embeds one tiny GC sentinel Wasm program in its JS loader. Give it
// the same compiled-module treatment as the main interpreter. Fail on a changed
// artifact shape rather than silently extracting the wrong embedded program.
const loaderSource = await readFile(runtime + 'pyodide.mjs', 'utf8');
const embedded = [...loaderSource.matchAll(/"(AGFzbQ[A-Za-z0-9+/=]+)"/g)];
if (embedded.length !== 1) throw new Error('Expected one Pyodide sentinel Wasm asset');
const sentinel = Buffer.from(embedded[0][1], 'base64');
const exports = WebAssembly.Module.exports(new WebAssembly.Module(sentinel)).map((item) => item.name).sort();
if (exports.join(',') !== 'create_sentinel,is_sentinel') throw new Error('Unexpected sentinel exports');
await writeFile('dist/sentinel.wasm', sentinel);
await copyFile(`${runtime}pyodide.asm.wasm`, 'dist/pyodide.asm.wasm');
await build({
  absWorkingDir: process.cwd(),
  entryPoints: [process.env.PYTHON_FIXTURE_ENTRY || 'worker.js'], outfile: process.env.PYTHON_FIXTURE_OUTPUT || 'dist/index.js', bundle: true,
  format: 'esm', platform: 'browser', target: 'es2022',
  external: ['node:*', './pyodide.asm.wasm', './sentinel.wasm'],
  loader: { '.zip': 'binary', '.py': 'text', '.whl': 'binary' },
  // These definitions affect only this generated fixture, not host globals.
  define: { process: 'undefined', location: '"https://python-runtime.invalid/"' },
  inject: ['./runtime-assets.js'],
  plugins: [{ name: 'sentinel-bytes', setup(builder) {
    builder.onResolve({ filter: /^pyodide-sentinel-bytes$/ }, () => ({ path: 'sentinel', namespace: 'sentinel' }));
    builder.onLoad({ filter: /.*/, namespace: 'sentinel' }, () => ({ contents: sentinel, loader: 'binary' }));
  } }],
});
const files = ['pyodide.mjs', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];
const assets = {};
assets['sentinel.wasm'] = { bytes: sentinel.length, sha256: createHash('sha256').update(sentinel).digest('hex'), source: 'embedded in pyodide.mjs' };
for (const name of files) {
  const bytes = await readFile(runtime + name);
  assets[name] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
await writeFile('dist/runtime-manifest.json', JSON.stringify({
  pyodide: '0.28.3',
  pythonAbi: JSON.parse(await readFile(runtime + 'pyodide-lock.json', 'utf8')).info,
  packaging: 'fixture-only; stdlib embedded in JS', assets,
}, null, 2) + '\n');
