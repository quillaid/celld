import { build } from 'esbuild';
import { mkdir, copyFile, readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, basename, join } from 'node:path';
import { consumePackages } from './consume-packages.mjs';

process.chdir(fileURLToPath(new URL('.', import.meta.url)));
const outdir = process.env.PYTHON_BUILD_OUTPUT_DIR || 'dist';
await mkdir(outdir, { recursive: true });
let generatedEntry, projectSources, packageDescriptor;
let packageArtifacts = [];
const dynamicLibraries = [];
if (process.env.PYTHON_PROJECT_FILE) {
  const main = resolve(process.env.PYTHON_PROJECT_FILE);
  const directory = dirname(main);
  const projectRoot = resolve(process.env.CELLD_PYTHON_PROJECT_ROOT || directory);
  const consumed = await consumePackages(projectRoot);
  packageArtifacts = consumed.artifacts;
  packageDescriptor = consumed.descriptor;
  projectSources = {};
  async function collect(dir, prefix = '') {
    for (const item of (await readdir(dir)).sort()) {
      if (item.startsWith('.') || item === 'node_modules' || item === '__pycache__') continue;
      const path = join(dir, item), relative = prefix + item;
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error('Python source symlinks are unsupported: ' + relative);
      if (stat.isDirectory()) await collect(path, relative + '/');
      else if (item.endsWith('.py')) projectSources[relative] = await readFile(path, 'utf8');
      else if ((item === 'pyproject.toml' || item.startsWith('requirements')) && resolve(dir) !== projectRoot) throw new Error('Python dependency manifests must live at the project root: ' + relative);
    }
  }
  await collect(directory);
  const moduleName = basename(main, '.py');
  if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(moduleName)) throw new Error('Python entry must have an importable module name');
  if (!(basename(main) in projectSources)) throw new Error('Python entry was not collected');
  const classes = JSON.parse(process.env.PYTHON_DURABLE_CLASSES || '[]');
  if (!Array.isArray(classes) || classes.some(name => typeof name !== 'string' || !/^[A-Za-z_][A-Za-z_0-9]*$/.test(name) || name === 'default')) throw new Error('Invalid Python Durable Object class names');
  generatedEntry = "import { createPythonDeployment } from './sdk-runtime.js';\nimport { paths as _dylibs } from 'celld-python-dylibs';\n";
  packageArtifacts.forEach((artifact, index) => { generatedEntry += `import _wheel${index} from ${JSON.stringify('celld-python-wheel/' + basename(artifact.path))};\n`; });
  generatedEntry += 'const deployment = createPythonDeployment({...' + JSON.stringify({ moduleName, files: projectSources }) + ', dynamicLibraries: _dylibs, packages: [' + packageArtifacts.map((_, index) => '_wheel' + index).join(',') + ']});\nexport default deployment.worker();\n';
  classes.forEach((name, index) => {
    generatedEntry += 'const _durable' + index + ' = deployment.durableObject(' + JSON.stringify(name) + ');\nexport { _durable' + index + ' as ' + name + ' };\n';
  });
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
  const sdkLock = JSON.parse(await readFile('sdk-lock.json', 'utf8'));
  validator.unpackArchive(new Uint8Array(await readFile('.celld/' + sdkLock.filename)), 'zip', { extractDir: '/sdk' });
  validator.FS.mkdirTree('/wheel-input');
  packageArtifacts.forEach((artifact, index) => validator.FS.writeFile(`/wheel-input/${index}.whl`, artifact.bytes));
  validator.globals.set('_celld_wheel_count', packageArtifacts.length);
  validator.globals.set('_celld_wheel_filenames', JSON.stringify(packageArtifacts.map(item => item.filename)));
  const nativePaths = JSON.parse(validator.runPython(await readFile('validate-wheels.py', 'utf8')));
  for (const artifact of packageArtifacts) validator.unpackArchive(new Uint8Array(artifact.bytes), 'zip', { extractDir: '/packages' });
  for (const path of nativePaths) {
    const bytes = validator.FS.readFile('/packages/' + path);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    // Validate the module before emitting an immutable compiled-module import.
    new WebAssembly.Module(bytes);
    const module = 'python-extension-' + sha256 + '.wasm';
    await writeFile(join(outdir, module), bytes);
    dynamicLibraries.push({ path, module, sha256, bytes });
  }
  for (const [name, source] of Object.entries(projectSources)) {
    if (!/^(?:[A-Za-z_][A-Za-z_0-9]*\/)*[A-Za-z_][A-Za-z_0-9]*\.py$/.test(name)) throw new Error('Invalid Python module path: ' + name);
    validator.FS.mkdirTree('/app/' + name.split('/').slice(0, -1).join('/'));
    validator.FS.writeFile('/app/' + name, source);
  }
  validator.runPython(await readFile('validate-sources.py', 'utf8'));
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
  external: ['node:*', 'cloudflare:workers', './pyodide.asm.wasm', './sentinel.wasm', './python-extension-*.wasm'],
  loader: { '.zip': 'binary', '.py': 'text', '.whl': 'binary' },
  // These definitions affect only this generated fixture, not host globals.
  define: { process: 'undefined', location: '"https://python-runtime.invalid/"' },
  inject: ['./runtime-assets.js'],
  plugins: [{ name: 'sentinel-bytes', setup(builder) {
    builder.onResolve({ filter: /^celld-python-dylibs$/ }, () => ({ path: 'libraries', namespace: 'python-dylibs' }));
    builder.onLoad({ filter: /.*/, namespace: 'python-dylibs' }, () => ({ contents:
      dynamicLibraries.map((item, index) => `import m${index} from ${JSON.stringify('./' + item.module)};\nimport b${index} from ${JSON.stringify('celld-python-dylib-bytes/' + item.sha256)};\n`).join('') +
      'export const paths = ' + JSON.stringify(dynamicLibraries.map(item => item.path)) + ';\n' +
      'export const artifacts = [' + dynamicLibraries.map((_, index) => `{module:m${index},bytes:b${index}}`).join(',') + '];', loader: 'js' }));
    builder.onResolve({ filter: /^celld-python-dylib-bytes\// }, args => ({ path: args.path.slice('celld-python-dylib-bytes/'.length), namespace: 'python-dylib-bytes' }));
    builder.onLoad({ filter: /.*/, namespace: 'python-dylib-bytes' }, args => {
      const artifact = dynamicLibraries.find(item => item.sha256 === args.path);
      if (!artifact) throw new Error('Unknown Python dynamic library');
      return { contents: artifact.bytes, loader: 'binary' };
    });
    builder.onResolve({ filter: /^pyodide-sentinel-bytes$/ }, () => ({ path: 'sentinel', namespace: 'sentinel' }));
    builder.onLoad({ filter: /.*/, namespace: 'sentinel' }, () => ({ contents: sentinel, loader: 'binary' }));
    // Stable content-addressed module names keep local cache paths out of the
    // bundle identity. Use already verified bytes, not a second filesystem read.
    builder.onResolve({ filter: /^celld-python-wheel\// }, args => ({ path: args.path.slice('celld-python-wheel/'.length), namespace: 'python-wheel' }));
    builder.onLoad({ filter: /.*/, namespace: 'python-wheel' }, args => {
      const artifact = packageArtifacts.find(item => basename(item.path) === args.path);
      if (!artifact) throw new Error('Unknown locked Python wheel');
      return { contents: artifact.bytes, loader: 'binary' };
    });
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
  packages: packageDescriptor,
  dynamicLibraries: dynamicLibraries.length ? dynamicLibraries.map(({ bytes, ...entry }) => entry) : undefined,
  sources: projectSources ? Object.fromEntries(Object.entries(projectSources).map(([name, contents]) => [name, createHash('sha256').update(contents).digest('hex')])) : undefined,
  pythonAbi: JSON.parse(await readFile(runtime + 'pyodide-lock.json', 'utf8')).info,
  packaging: generatedEntry ? 'experimental-native-python-v1' : 'fixture-only; stdlib embedded in JS', assets,
}, null, 2) + '\n');
