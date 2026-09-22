import { build } from 'esbuild';
import { mkdir, copyFile, readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, basename, join } from 'node:path';

process.chdir(fileURLToPath(new URL('.', import.meta.url)));
const outdir = process.env.PYTHON_BUILD_OUTPUT_DIR || 'dist';
await mkdir(outdir, { recursive: true });
let generatedEntry, projectSources;
if (process.env.PYTHON_PROJECT_FILE) {
  const main = resolve(process.env.PYTHON_PROJECT_FILE);
  const directory = dirname(main);
  projectSources = {};
  async function collect(dir, prefix = '') {
    for (const item of (await readdir(dir)).sort()) {
      if (item.startsWith('.') || item === 'node_modules' || item === '__pycache__') continue;
      const path = join(dir, item), relative = prefix + item;
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error('Python source symlinks are unsupported: ' + relative);
      if (stat.isDirectory()) await collect(path, relative + '/');
      else if (item.endsWith('.py')) projectSources[relative] = await readFile(path, 'utf8');
      else if (item === 'pyproject.toml' || item.startsWith('requirements')) throw new Error('Python dependency manifests need the pending package resolver: ' + relative);
    }
  }
  await collect(directory);
  const moduleName = basename(main, '.py');
  if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(moduleName)) throw new Error('Python entry must have an importable module name');
  if (!(basename(main) in projectSources)) throw new Error('Python entry was not collected');
  generatedEntry = "import { createPythonWorker } from './sdk-runtime.js';\nexport default createPythonWorker(" + JSON.stringify({ moduleName, files: projectSources }) + ');';
}
const runtime = 'node_modules/pyodide/';
const runtimeLock = JSON.parse(await readFile('runtime-lock.json', 'utf8'));
for (const [name, expected] of Object.entries(runtimeLock.assets)) {
  if (name === 'sentinel.wasm') continue;
  const bytes = await readFile(runtime + name);
  if (createHash('sha256').update(bytes).digest('hex') !== expected.sha256) throw new Error('Pinned Python runtime hash mismatch: ' + name);
}
if (projectSources) {
  // Validate with exactly the target CPython, without executing application
  // top-level code or relying on the build machine's Python installation.
  const { loadPyodide } = await import('pyodide');
  const validator = await loadPyodide({ indexURL: resolve(runtime) + '/' });
  validator.globals.set('_celld_sources_json', JSON.stringify(projectSources));
  validator.runPython(`import json
for _name, _source in json.loads(_celld_sources_json).items():
    compile(_source, _name, 'exec', dont_inherit=True)
del _name, _source, _celld_sources_json
`);
}
// Pyodide embeds one tiny GC sentinel Wasm program in its JS loader. Give it
// the same compiled-module treatment as the main interpreter. Fail on a changed
// artifact shape rather than silently extracting the wrong embedded program.
const loaderSource = await readFile(runtime + 'pyodide.mjs', 'utf8');
const embedded = [...loaderSource.matchAll(/"(AGFzbQ[A-Za-z0-9+/=]+)"/g)];
if (embedded.length !== 1) throw new Error('Expected one Pyodide sentinel Wasm asset');
const sentinel = Buffer.from(embedded[0][1], 'base64');
const exports = WebAssembly.Module.exports(new WebAssembly.Module(sentinel)).map((item) => item.name).sort();
if (exports.join(',') !== 'create_sentinel,is_sentinel') throw new Error('Unexpected sentinel exports');
await writeFile(join(outdir, 'sentinel.wasm'), sentinel);
await copyFile(`${runtime}pyodide.asm.wasm`, join(outdir, 'pyodide.asm.wasm'));
await build({
  absWorkingDir: process.cwd(),
  ...(generatedEntry ? { stdin: { contents: generatedEntry, resolveDir: process.cwd(), sourcefile: 'python-entry.js' } } : { entryPoints: [process.env.PYTHON_FIXTURE_ENTRY || 'worker.js'] }),
  outfile: process.env.PYTHON_FIXTURE_OUTPUT || join(outdir, 'index.js'), bundle: true,
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
await writeFile(join(outdir, 'runtime-manifest.json'), JSON.stringify({
  schema: 1,
  pyodide: '0.28.3',
  sdk: generatedEntry ? JSON.parse(await readFile('sdk-lock.json', 'utf8')) : undefined,
  sources: projectSources ? Object.fromEntries(Object.entries(projectSources).map(([name, contents]) => [name, createHash('sha256').update(contents).digest('hex')])) : undefined,
  pythonAbi: JSON.parse(await readFile(runtime + 'pyodide-lock.json', 'utf8')).info,
  packaging: generatedEntry ? 'experimental-native-python-v1' : 'fixture-only; stdlib embedded in JS', assets,
}, null, 2) + '\n');
