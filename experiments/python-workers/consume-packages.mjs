import { readFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifiedDownload } from './lock-packages.mjs';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export async function consumePackages(directory) {
  const names = await readdir(directory);
  const manifests = names.filter(name => name === 'pyproject.toml' || name.startsWith('requirements'));
  if (!manifests.length) {
    if (names.includes('celld-python.lock.json')) throw new Error('Python package lock has no dependency manifest');
    return { artifacts: [] };
  }
  if (manifests.length !== 1 || !['pyproject.toml', 'requirements.txt'].includes(manifests[0])) throw new Error('Use exactly one pyproject.toml or requirements.txt dependency manifest');
  let lockBytes;
  try { lockBytes = await readFile(join(directory, 'celld-python.lock.json')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('Python dependencies require celld-python.lock.json; run lock-packages.mjs for this project');
    throw error;
  }
  const lock = JSON.parse(lockBytes);
  if (lock.schema !== 1 || lock.pyodide !== '0.28.3' || lock.python !== '3.13.2' || lock.abi?.python !== '3.13.2' || lock.abi?.abi_version !== '2025_0' || lock.abi?.arch !== 'wasm32' || lock.abi?.platform !== 'emscripten_4_0_9') throw new Error('Python package lock target ABI does not match the pinned runtime');
  if (lock.manifest?.name !== manifests[0] || lock.manifest.sha256 !== digest(await readFile(join(directory, manifests[0])))) throw new Error('Python package lock is stale; regenerate it for the current dependency manifest');
  if (!Array.isArray(lock.packages) || !Array.isArray(lock.roots)) throw new Error('Invalid Python package lock');
  const seen = new Set();
  const root = fileURLToPath(new URL('.', import.meta.url));
  const runtimeLock = JSON.parse(await readFile(join(root, 'runtime-lock.json'), 'utf8'));
  const indexBytes = await readFile(join(root, 'node_modules/pyodide/pyodide-lock.json'));
  if (digest(indexBytes) !== runtimeLock.assets['pyodide-lock.json'].sha256) throw new Error('Pinned runtime package index hash mismatch');
  const runtimeIndex = JSON.parse(indexBytes);
  for (const entry of lock.packages) {
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(entry.name) || seen.has(entry.name) || typeof entry.version !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Array.isArray(entry.depends)) throw new Error('Invalid or unsupported locked Python artifact');
    if (entry.kind === 'shared-library') {
      const pinned = runtimeIndex.packages[entry.name];
      if (!pinned || pinned.package_type !== 'shared_library' || pinned.install_dir !== 'dynlib' || entry.version !== pinned.version || entry.filename !== pinned.file_name || entry.sha256 !== pinned.sha256 || entry.url !== 'https://cdn.jsdelivr.net/pyodide/v0.28.3/full/' + pinned.file_name || JSON.stringify([...entry.depends].sort()) !== JSON.stringify(pinned.depends.map(name => name.toLowerCase().replace(/[-_.]+/g, '-')).sort())) throw new Error('Shared-library archive must match the pinned runtime index');
    } else if (entry.kind !== undefined || !/^[^/\\]+-(?:(?:py3|py2\.py3)-none-any|cp313-cp313-pyodide_2025_0_wasm32)\.whl$/.test(entry.filename)) throw new Error('Invalid or unsupported locked Python wheel');
    const url = new URL(entry.url);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Locked Python wheels require HTTPS origins without credentials');
    seen.add(entry.name);
  }
  for (const name of [...lock.roots, ...lock.packages.flatMap(entry => entry.depends)]) if (!seen.has(name)) throw new Error('Python package lock has a missing dependency: ' + name);
  const wheelDirectory = join(directory, '.celld/python-wheels');
  await mkdir(wheelDirectory, { recursive: true });
  const artifacts = [];
  const ordered = [], visited = new Set(), visiting = new Set();
  const entries = new Map(lock.packages.map(entry => [entry.name, entry]));
  function visit(name) {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error('Python package dependency cycle: ' + name);
    visiting.add(name);
    const entry = entries.get(name);
    for (const dependency of [...entry.depends].sort()) visit(dependency);
    visiting.delete(name);
    visited.add(name);
    ordered.push(entry);
  }
  [...entries.keys()].sort().forEach(visit);
  for (const entry of ordered) {
    const path = join(wheelDirectory, entry.sha256 + (entry.kind === 'shared-library' ? '.zip' : '.whl'));
    artifacts.push({ path, filename: entry.filename, kind: entry.kind, bytes: await verifiedDownload(entry.url, entry.sha256, path) });
  }
  return { artifacts, descriptor: { sha256: digest(lockBytes), lock } };
}
