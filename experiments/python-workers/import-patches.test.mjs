import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadPyodide } from 'pyodide';

test('SDK import patches preserve loader behavior and clean up nested or failed imports', async () => {
  const root = new URL('.', import.meta.url);
  const python = await loadPyodide({ indexURL: fileURLToPath(new URL('node_modules/pyodide/', root)) });
  python.unpackArchive(new Uint8Array(await readFile(new URL('.celld/workers_runtime_sdk-1.9.0-py3-none-any.whl', root))), 'zip', { extractDir: '/sdk' });
  python.runPython("import sys\nfrom pathlib import Path\nPath('/app').mkdir()\nsys.path[:0] = ['/app', '/sdk']\nPath('/app/_workers_sdk_package_patches.py').write_text(\"raise AssertionError('Application shadowed SDK patch module')\")");
  python.runPython(await readFile(new URL('sdk-import-patches.py', root), 'utf8'));
  const observation = JSON.parse(python.runPython(`
import json
assert '_workers_sdk_package_patches' in sys.modules
assert sys.modules['_workers_sdk_package_patches'].__file__ == '/sdk/_workers_sdk_package_patches.py'
assert 'anyio.to_thread' in _sdk_exec_patches
baseline = list(sys.meta_path)
events = []
@_register_sdk_exec_patch('patched_child')
@contextmanager
def child_patch(module):
    events.append('enter')
    try:
        yield
        module.answer += 1
    finally:
        events.append('exit')
Path('/app/patched_child.py').write_text('answer = 41')
Path('/app/patched_parent.py').write_text('import patched_child\\nanswer = patched_child.answer')
importlib.invalidate_caches()
with _sdk_package_imports():
    parent = _load_application('patched_parent')
    assert len(sys.meta_path) == len(baseline) + 1
assert sys.meta_path == baseline
assert parent.answer == 42
assert sys.modules['patched_child'].__loader__.get_source('patched_child') == 'answer = 41'
assert events == ['enter', 'exit']
assert _load_application('patched_parent') is parent
assert events == ['enter', 'exit']
@_register_sdk_exec_patch('broken_child')
@contextmanager
def broken_patch(module):
    events.append('broken-enter')
    try:
        yield
    finally:
        events.append('broken-exit')
Path('/app/broken_child.py').write_text("raise ValueError('intentional import failure')")
importlib.invalidate_caches()
try:
    _load_application('broken_child')
except ValueError as error:
    assert str(error) == 'intentional import failure'
else:
    raise AssertionError('Failed import was swallowed')
assert sys.meta_path == baseline
assert 'broken_child' not in sys.modules
assert events[-2:] == ['broken-enter', 'broken-exit']
assert _load_application('patched_parent').answer == 42
# Patches apply only during admitted application loading, not later imports.
Path('/app/outside_scope.py').write_text('answer = 10')
importlib.invalidate_caches()
_register_sdk_exec_patch('outside_scope', child_patch)
assert importlib.import_module('outside_scope').answer == 10
json.dumps({'answer': parent.answer, 'events': events, 'cleanup': sys.meta_path == baseline, 'sdkPath': sys.modules['_workers_sdk_package_patches'].__file__})
`));
  assert.equal(observation.answer, 42);
  assert.equal(observation.cleanup, true);
  assert.deepEqual(observation.events, ['enter', 'exit', 'broken-enter', 'broken-exit']);
});
