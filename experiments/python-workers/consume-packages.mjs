import { readFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
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
  for (const entry of lock.packages) {
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(entry.name) || seen.has(entry.name) || typeof entry.version !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256) || !/^[^/\\]+-(?:(?:py3|py2\.py3)-none-any|cp313-cp313-pyodide_2025_0_wasm32)\.whl$/.test(entry.filename) || !Array.isArray(entry.depends)) throw new Error('Invalid or unsupported locked Python wheel');
    const url = new URL(entry.url);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Locked Python wheels require HTTPS origins without credentials');
    seen.add(entry.name);
  }
  for (const name of [...lock.roots, ...lock.packages.flatMap(entry => entry.depends)]) if (!seen.has(name)) throw new Error('Python package lock has a missing dependency: ' + name);
  const wheelDirectory = join(directory, '.celld/python-wheels');
  await mkdir(wheelDirectory, { recursive: true });
  const artifacts = [];
  for (const entry of lock.packages) {
    const path = join(wheelDirectory, entry.sha256 + '.whl');
    artifacts.push({ path, filename: entry.filename, bytes: await verifiedDownload(entry.url, entry.sha256, path) });
  }
  return { artifacts, descriptor: { sha256: digest(lockBytes), lock } };
}
