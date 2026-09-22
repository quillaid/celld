import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadPyodide } from 'pyodide';
import { consumePackages } from './consume-packages.mjs';
const root = fileURLToPath(new URL('.', import.meta.url));
const exec = promisify(execFile);
test('target package resolution pins transitive wheels and supports offline target imports', { timeout: 60000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'celld-package-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lockPath = join(directory, 'celld-python.lock.json');
  const run = () => exec(process.execPath, [join(root, 'lock-packages.mjs'), directory], { timeout: 30000 });
  await writeFile(join(directory, 'requirements.txt'), 'python-dateutil==2.9.0.post0\nhumanize==4.12.3\n');
  await run();
  const first = await readFile(lockPath, 'utf8');
  await run();
  assert.equal(await readFile(lockPath, 'utf8'), first);
  const lock = JSON.parse(first);
  assert.deepEqual(lock.packages.map(item => item.name), ['humanize', 'python-dateutil', 'six']);
  assert.deepEqual(lock.packages[1].depends, ['six']);
  assert.match(lock.packages[0].url, /^https:\/\/files\.pythonhosted\.org\//);
  assert.ok(!first.includes(directory));
  assert.ok(!first.includes(root));
  const python = await loadPyodide({ indexURL: join(root, 'node_modules/pyodide/') });
  for (const entry of lock.packages) {
    const bytes = await readFile(join(directory, '.celld/python-wheels', entry.sha256 + '.whl'));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
    python.unpackArchive(new Uint8Array(bytes), 'zip', { extractDir: '/packages' });
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Offline import attempted a network request'); };
  let imported;
  try {
    imported = JSON.parse(python.runPython("import sys, json; sys.path.insert(0, '/packages')\nfrom dateutil.parser import isoparse\nimport humanize\njson.dumps({'date': isoparse('2026-09-21T12:34:56Z').isoformat(), 'number': humanize.intcomma(1234567)})"));
  } finally { globalThis.fetch = originalFetch; }
  assert.deepEqual(imported, { date: '2026-09-21T12:34:56+00:00', number: '1,234,567' });
  await rm(join(directory, 'requirements.txt'));
  await writeFile(join(directory, 'pyproject.toml'), `[project]\nname="package-probe"\nversion="0.0.0"\ndependencies=["python-dateutil==2.9.0.post0; sys_platform == 'emscripten'", "humanize==4.12.3", "celld-must-not-resolve-host-only; sys_platform == 'darwin'"]\n`);
  await run();
  const targetLock = JSON.parse(await readFile(lockPath, 'utf8'));
  assert.deepEqual(targetLock.roots, ['humanize', 'python-dateutil']);
  assert.deepEqual(targetLock.packages, lock.packages);
  const validLock = await readFile(lockPath, 'utf8');
  const wheelPath = join(directory, '.celld/python-wheels', lock.packages[0].sha256 + '.whl');
  const validWheel = await readFile(wheelPath);
  await writeFile(wheelPath, 'corrupt cache');
  await assert.rejects(run(), error => /Package artifact hash mismatch/.test(error.stderr));
  assert.equal(await readFile(lockPath, 'utf8'), validLock);
  await writeFile(wheelPath, validWheel);
  await writeFile(join(directory, 'pyproject.toml'), '[project]\nname="conflict"\ndependencies=["six==1.17.0", "six==1.16.0"]\n');
  await assert.rejects(run(), error => /six/.test(error.stderr) && /1\.1[67]\.0/.test(error.stderr));
  assert.equal(await readFile(lockPath, 'utf8'), validLock);
  await writeFile(join(directory, 'pyproject.toml'), '[project]\nname="dynamic"\ndynamic=["dependencies"]\n');
  await assert.rejects(run(), error => /Dynamic project dependencies are unsupported/.test(error.stderr));
  assert.equal(await readFile(lockPath, 'utf8'), validLock);
  await mkdir(join(root, 'results'), { recursive: true });
  await writeFile(join(root, 'results/packages.json'), JSON.stringify({ timestamp: new Date().toISOString(), lock, targetMarkerRoots: targetLock.roots, importedOffline: imported, reproducible: true, corruptCacheRejected: true, conflictingRequirementsRejected: true, dynamicDependenciesRejected: true, priorLockPreserved: true }, null, 2) + '\n');
});

test('bundled Pydantic locks canonical compiled dependencies and validates offline', { timeout: 60000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'celld-pydantic-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lockPath = join(directory, 'celld-python.lock.json');
  const run = () => exec(process.execPath, [join(root, 'lock-packages.mjs'), directory], { timeout: 30000 });
  await writeFile(join(directory, 'requirements.txt'), 'pydantic==2.10.6\n');
  await run();
  const first = await readFile(lockPath, 'utf8');
  await run();
  assert.equal(await readFile(lockPath, 'utf8'), first);
  const lock = JSON.parse(first);
  assert.deepEqual(lock.packages.map(item => item.name), ['annotated-types', 'pydantic', 'pydantic-core', 'typing-extensions']);
  assert.deepEqual(lock.packages.find(item => item.name === 'pydantic').depends, ['annotated-types', 'pydantic-core', 'typing-extensions']);
  const python = await loadPyodide({ indexURL: join(root, 'node_modules/pyodide/') });
  for (const entry of lock.packages) {
    const bytes = await readFile(join(directory, '.celld/python-wheels', entry.sha256 + '.whl'));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
    python.unpackArchive(new Uint8Array(bytes), 'zip', { extractDir: '/packages' });
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Offline Pydantic validation attempted a network request'); };
  let validation;
  try {
    validation = JSON.parse(python.runPython(`
import sys, json
sys.path.insert(0, '/packages')
from pydantic import BaseModel, Field, ValidationError
import pydantic_core._pydantic_core as core
class Item(BaseModel):
    name: str
    count: int = Field(gt=0)
valid = Item.model_validate({'name': 'café', 'count': '3'}).model_dump()
try:
    Item.model_validate({'name': 'bad', 'count': 0})
except ValidationError as error:
    invalid = error.errors(include_url=False)
json.dumps({'valid': valid, 'invalid': invalid, 'extension': core.__file__})
`));
  } finally { globalThis.fetch = originalFetch; }
  assert.deepEqual(validation.valid, { name: 'café', count: 3 });
  assert.equal(validation.invalid[0].type, 'greater_than');
  assert.match(validation.extension, /pydantic_core\/.*\.so$/);
  // AnyIO's Pyodide index omits idna even though its wheel requires it. Resolve
  // that missing wheel and retain its edge alongside SSL's native libraries.
  await writeFile(join(directory, 'requirements.txt'), 'anyio==4.9.0\n');
  await run();
  const anyioText = await readFile(lockPath, 'utf8');
  await run();
  assert.equal(await readFile(lockPath, 'utf8'), anyioText);
  const anyioLock = JSON.parse(anyioText);
  assert.ok(anyioLock.packages.find(item => item.name === 'anyio').depends.includes('idna'));
  const archive = anyioLock.packages.find(item => item.name === 'libopenssl');
  assert.equal(archive.kind, 'shared-library');
  const consumed = await consumePackages(directory);
  const order = consumed.artifacts.map(item => item.filename);
  assert.ok(order.indexOf(archive.filename) < order.findIndex(name => name.startsWith('ssl-')));
  const tampered = structuredClone(anyioLock);
  tampered.packages.find(item => item.name === 'libopenssl').sha256 = 'a'.repeat(64);
  await writeFile(lockPath, JSON.stringify(tampered));
  await assert.rejects(consumePackages(directory), /Shared-library archive must match the pinned runtime index/);
  await writeFile(lockPath, anyioText);
  const archivePath = join(directory, '.celld/python-wheels', archive.sha256 + '.zip');
  const validArchive = await readFile(archivePath);
  await writeFile(archivePath, 'corrupted shared library archive');
  await assert.rejects(consumePackages(directory), /Package artifact hash mismatch/);
  await writeFile(archivePath, validArchive);
  await mkdir(join(root, 'results'), { recursive: true });
  await writeFile(join(root, 'results/pydantic-packages.json'), JSON.stringify({ timestamp: new Date().toISOString(), lock, validation, reproducible: true, anyioLock, artifactOrder: order, archiveTamperingRejected: true, qualification: 'Node-hosted pinned Pyodide; native-fastapi.test.mjs separately checks celld/workerd' }, null, 2) + '\n');
});

test('shared-library archive validation rejects unsafe paths, collisions and non-Wasm payloads', async () => {
  const python = await loadPyodide({ indexURL: join(root, 'node_modules/pyodide/') });
  const validator = await readFile(join(root, 'validate-wheels.py'), 'utf8');
  python.globals.set('_validator', validator);
  python.runPython(`
import json, zipfile, stat
from pathlib import Path
Path('/wheel-input').mkdir()
_celld_wheel_count = 1
_celld_wheel_filenames = json.dumps(['library.zip'])
_celld_artifact_kinds = json.dumps(['shared-library'])
def check_archive(names, payload=b'\\x00asm\\x01\\x00\\x00\\x00', symlink=False):
    with zipfile.ZipFile('/wheel-input/0.whl', 'w') as archive:
        for name in names:
            info = zipfile.ZipInfo(name)
            if symlink:
                info.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(info, payload)
    exec(compile(_validator, 'validate-wheels.py', 'exec'), globals())
`);
  python.runPython("check_archive(['libcrypto.so', 'libssl.so'])");
  for (const [expression, pattern] of [
    ["check_archive(['../escape.so'])", /Invalid wheel path/],
    ["check_archive(['/escape.so'])", /Invalid wheel path/],
    ["check_archive(['nested/library.so'])", /flat .so files/],
    ["check_archive(['hook.pth'])", /flat .so files/],
    ["check_archive(['library.so'], symlink=True)", /symlinks are unsupported/],
    ["check_archive(['library.so'], payload=b'ELF-native')", /not a target Wasm module/],
    ["check_archive(['library.so', 'library.so'])", /file collision/],
  ]) assert.throws(() => python.runPython(expression), pattern);
});
