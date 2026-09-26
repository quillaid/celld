"""Validate supported pure/Pyodide wheel layouts before unpacking packages."""
import email.parser
import stat
import zipfile
import json

_paths = set()
_native_paths = []
_filenames = json.loads(_celld_wheel_filenames)
_kinds = json.loads(_celld_artifact_kinds) if '_celld_artifact_kinds' in globals() else ['wheel'] * _celld_wheel_count
for _index in range(_celld_wheel_count):
    with zipfile.ZipFile(f'/wheel-input/{_index}.whl') as _wheel:
        _shared = _kinds[_index] == 'shared-library'
        _metadata = [name for name in _wheel.namelist() if name.endswith('.dist-info/WHEEL')]
        if not _shared and len(_metadata) != 1:
            raise ValueError('Wheel must contain one WHEEL metadata file')
        _info = email.parser.Parser().parsestr(_wheel.read(_metadata[0]).decode()) if not _shared else None
        _native = _filenames[_index].endswith('-cp313-cp313-pyodide_2025_0_wasm32.whl')
        if _native:
            if 'cp313-cp313-pyodide_2025_0_wasm32' not in _info.get_all('Tag', []):
                raise ValueError('Native wheel metadata does not match the target ABI')
        elif not _shared and _info.get('Root-Is-Purelib', '').lower() != 'true':
            raise ValueError('Pure wheel must declare a pure Python layout')
        for _member in sorted(_wheel.infolist(), key=lambda item: item.filename):
            _name = _member.filename
            _parts = _name.rstrip('/').split('/')
            if not _name or _name.startswith('/') or '\\' in _name or any(part in ('', '.', '..') for part in _parts):
                raise ValueError(f'Invalid wheel path: {_name}')
            if stat.S_ISLNK(_member.external_attr >> 16):
                raise ValueError(f'Wheel symlinks are unsupported: {_name}')
            if _shared and (len(_parts) != 1 or not _name.endswith('.so') or _member.is_dir()):
                raise ValueError(f'Shared-library archive requires flat .so files: {_name}')
            if _parts[0] in ('workers', 'workers.py', 'pyodide', '_pyodide'):
                raise ValueError(f'Wheel conflicts with the runtime SDK: {_name}')
            if _parts[0].endswith('.data') or _name.endswith('.pth'):
                raise ValueError(f'Wheel relocation and .pth hooks are unsupported: {_name}')
            if not _member.is_dir():
                if _name in _paths:
                    raise ValueError(f'Wheel file collision: {_name}')
                _paths.add(_name)
                if _name.endswith('.so'):
                    if not (_native or _shared) or _wheel.read(_member)[:8] != b'\x00asm\x01\x00\x00\x00':
                        raise ValueError(f'Extension is not a target Wasm module: {_name}')
                    _native_paths.append(_name)

json.dumps(_native_paths)
