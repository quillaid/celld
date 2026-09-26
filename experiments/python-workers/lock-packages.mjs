#!/usr/bin/env node
// Resolve project dependencies inside the pinned target interpreter. This is a
// build-time tool; deploying a project must consume its lock, never re-resolve.
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPyodide } from 'pyodide';

const root = fileURLToPath(new URL('.', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export async function lockPackages(directory) {
  directory = resolve(directory);
  const manifests = [];
  for (const name of ['pyproject.toml', 'requirements.txt']) {
    try { manifests.push({ name, contents: await readFile(join(directory, name), 'utf8') }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (manifests.length !== 1) throw new Error('Provide exactly one of pyproject.toml or requirements.txt');
  const runtimeDirectory = join(root, 'node_modules/pyodide');
  const runtime = JSON.parse(await readFile(join(root, 'runtime-lock.json'), 'utf8'));
  for (const [name, expected] of Object.entries(runtime.assets)) {
    if (name === 'sentinel.wasm') continue;
    if (digest(await readFile(join(runtimeDirectory, name))) !== expected.sha256) throw new Error('Pinned runtime hash mismatch: ' + name);
  }
  const packageCacheDir = join(root, '.celld/resolver-packages');
  await mkdir(packageCacheDir, { recursive: true });
  const runtimeIndex = JSON.parse(await readFile(join(runtimeDirectory, 'pyodide-lock.json'), 'utf8'));
  const cdn = 'https://cdn.jsdelivr.net/pyodide/v0.28.3/full/';
  // Verify even cached resolver bytes before executing them.
  const resolverWheel = runtimeIndex.packages.micropip;
  await verifiedDownload(cdn + resolverWheel.file_name, resolverWheel.sha256, join(packageCacheDir, resolverWheel.file_name));
  const python = await loadPyodide({ indexURL: runtimeDirectory + '/', packageCacheDir });
  await python.loadPackage('micropip');
  python.globals.set('_celld_manifest_json', JSON.stringify(manifests[0]));
  const requirements = JSON.parse(python.runPython(`
import json, tomllib
_manifest = json.loads(_celld_manifest_json)
if _manifest['name'] == 'pyproject.toml':
    _project = tomllib.loads(_manifest['contents']).get('project', {})
    if 'dependencies' in _project.get('dynamic', []):
        raise ValueError('Dynamic project dependencies are unsupported')
    _requirements = _project.get('dependencies', [])
else:
    _requirements = [line.split(' #', 1)[0].strip() for line in _manifest['contents'].splitlines()
                     if line.strip() and not line.lstrip().startswith('#')]
if not isinstance(_requirements, list) or not all(isinstance(item, str) for item in _requirements):
    raise ValueError('Dependencies must be an array of PEP 508 strings')
if any(item.startswith('-') or item.endswith('\\\\') for item in _requirements):
    raise ValueError('requirements.txt accepts PEP 508 lines, not pip options or continuations')
json.dumps(_requirements)
`));
  python.globals.set('_celld_requirements_json', JSON.stringify(requirements));
  const resolution = JSON.parse(await python.runPythonAsync(`
import micropip
import importlib.metadata
from micropip._vendored.packaging.src.packaging.requirements import Requirement
from micropip._vendored.packaging.src.packaging.utils import canonicalize_name
from micropip._vendored.packaging.src.packaging.specifiers import SpecifierSet
_parsed = [Requirement(item) for item in json.loads(_celld_requirements_json)]
if any(req.url and not req.url.startswith('https://') for req in _parsed):
    raise ValueError('Direct wheel references must use HTTPS')
_active = [req for req in _parsed if req.marker is None or req.marker.evaluate()]
await micropip.install([str(req) for req in _active])
# micropip can accept conflicting roots in one concurrent install. Verify the
# installed closure, including extras/markers, before publishing any lock.
_pending = list(_active)
_seen = set()
_required = set()
_versions = {}
_dependencies = {}
while _pending:
    _req = _pending.pop()
    _name = canonicalize_name(_req.name)
    try:
        _dist = importlib.metadata.distribution(_name)
    except importlib.metadata.PackageNotFoundError:
        # Pyodide's index can omit dependencies declared by the wheel itself.
        # Complete that metadata closure in the target before freezing it.
        await micropip.install(str(_req))
        _dist = importlib.metadata.distribution(_name)
    if _req.specifier and not _req.specifier.contains(_dist.version, prereleases=True):
        raise ValueError(f'Unsatisfied requirement {_req}: installed {_name}=={_dist.version}')
    _python = _dist.metadata.get('Requires-Python')
    if _python and not SpecifierSet(_python).contains('3.13.2', prereleases=True):
        raise ValueError(f'{_name} requires Python {_python}, target is 3.13.2')
    _key = (_name, tuple(sorted(_req.extras)))
    if _key in _seen:
        continue
    _seen.add(_key)
    _required.add(_name)
    _versions[_name] = _dist.version
    _dependencies.setdefault(_name, set())
    for _raw in _dist.requires or []:
        _child = Requirement(_raw)
        if _child.marker is None or any(_child.marker.evaluate({'extra': extra}) for extra in {'', *_req.extras}):
            _dependencies[_name].add(canonicalize_name(_child.name))
            _pending.append(_child)
json.dumps({'roots': sorted(set(canonicalize_name(req.name) for req in _active)), 'required': sorted(_required), 'versions': _versions, 'dependencies': {name: sorted(children) for name, children in _dependencies.items()}, 'frozen': json.loads(micropip.freeze())})
`));
  const canonicalize = name => name.toLowerCase().replace(/[-_.]+/g, '-');
  const frozen = new Map();
  for (const [rawName, entry] of Object.entries(resolution.frozen.packages)) {
    const name = canonicalize(rawName);
    if (frozen.has(name)) throw new Error('Duplicate canonical frozen dependency: ' + name);
    frozen.set(name, { ...entry, depends: [...new Set([...entry.depends.map(canonicalize), ...(resolution.dependencies[name] || [])])].sort() });
  }
  const selected = new Map();
  function visit(name) {
    if (selected.has(name)) return;
    const entry = frozen.get(name);
    if (!entry) throw new Error('Resolved dependency missing from freeze: ' + name);
    const filename = basename(entry.file_name.startsWith('https://') ? new URL(entry.file_name).pathname : entry.file_name);
    const bundled = runtimeIndex.packages[name];
    const shared = bundled?.package_type === 'shared_library' && bundled.install_dir === 'dynlib' && bundled.file_name === filename && bundled.version === entry.version && bundled.sha256 === entry.sha256;
    if (!filename.endsWith('.whl') && !shared) throw new Error('Unsupported runtime archive: ' + name + ' (' + filename + ')');
    // Runtime dependencies such as ssl may have no distribution metadata.
    // They are still required by, and pinned to, the verified runtime index.
    if (resolution.versions[name] !== undefined && resolution.versions[name] !== entry.version) throw new Error('Frozen dependency does not match verified installed version: ' + name);
    if (resolution.versions[name] === undefined) {
      const bundled = runtimeIndex.packages[name];
      if (!bundled || bundled.version !== entry.version || bundled.sha256 !== entry.sha256) throw new Error('Unverified runtime dependency: ' + name);
    }
    selected.set(name, { ...entry, ...(shared ? { kind: 'shared-library' } : {}) });
    for (const dependency of entry.depends) visit(dependency);
  }
  resolution.required.forEach(visit);
  const packages = [];
  const wheelDirectory = join(directory, '.celld/python-wheels');
  await mkdir(wheelDirectory, { recursive: true });
  for (const [name, entry] of [...selected].sort(([a], [b]) => a.localeCompare(b))) {
    const bundled = runtimeIndex.packages[name];
    const url = bundled?.version === entry.version && bundled.sha256 === entry.sha256
      ? cdn + bundled.file_name : entry.file_name;
    if (typeof url !== 'string' || !url.startsWith('https://')) throw new Error('Package has no reproducible HTTPS origin: ' + name);
    const filename = basename(new URL(url).pathname);
    // Native wheels must match the pinned CPython and Pyodide ABI exactly.
    // Platform wheels for the build machine are never deployment artifacts.
    if (entry.kind !== 'shared-library' && !/-(?:(?:py3|py2\.py3)-none-any|cp313-cp313-pyodide_2025_0_wasm32)\.whl$/.test(filename)) throw new Error('Wheel does not match the supported Python/Pyodide ABI: ' + filename);
    if (!/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Package lacks a SHA-256 digest: ' + name);
    await verifiedDownload(url, entry.sha256, join(wheelDirectory, entry.sha256 + (entry.kind === 'shared-library' ? '.zip' : '.whl')));
    packages.push({ name, version: entry.version, filename, url, sha256: entry.sha256, depends: [...entry.depends].sort(), ...(entry.kind ? { kind: entry.kind } : {}) });
  }
  const lock = {
    schema: 1, pyodide: '0.28.3', python: '3.13.2',
    resolver: { name: 'micropip', version: '0.10.1' },
    manifest: { name: manifests[0].name, sha256: digest(manifests[0].contents) },
    requirements, roots: resolution.roots, abi: runtimeIndex.info, packages,
  };
  const temporary = join(directory, '.celld', 'python-lock-' + process.pid + '.json');
  await writeFile(temporary, JSON.stringify(lock, null, 2) + '\n');
  await rename(temporary, join(directory, 'celld-python.lock.json'));
  return lock;
}

export async function verifiedDownload(url, sha256, target) {
  let bytes;
  let downloaded = false;
  try { bytes = await readFile(target); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Package download failed: ${response.status} ${url}`);
    bytes = new Uint8Array(await response.arrayBuffer());
    downloaded = true;
  }
  if (digest(bytes) !== sha256) throw new Error('Package artifact hash mismatch: ' + url);
  // Readers never observe a partially written cache entry, even when separate
  // build processes fetch the same missing wheel concurrently.
  if (downloaded) {
    const temporary = target + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, bytes);
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
  }
  return bytes;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node lock-packages.mjs PROJECT_DIRECTORY');
    const lock = await lockPackages(process.argv[2]);
    console.log(`Locked ${lock.requirements.length} requirements for Pyodide ${lock.pyodide}`);
  } catch (error) { console.error(error?.message || String(error)); process.exitCode = 1; }
}
