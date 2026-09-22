"""Validate supported pure/Pyodide wheel layouts before unpacking packages."""
import email.parser
import stat
import zipfile
import json

_paths = set()
_native_paths = []
_filenames = json.loads(_celld_wheel_filenames)
for _index in range(_celld_wheel_count):
    with zipfile.ZipFile(f'/wheel-input/{_index}.whl') as _wheel:
        _metadata = [name for name in _wheel.namelist() if name.endswith('.dist-info/WHEEL')]
        if len(_metadata) != 1:
            raise ValueError('Wheel must contain one WHEEL metadata file')
        _info = email.parser.Parser().parsestr(_wheel.read(_metadata[0]).decode())
        _native = _filenames[_index].endswith('-cp313-cp313-pyodide_2025_0_wasm32.whl')
        if _native:
            if 'cp313-cp313-pyodide_2025_0_wasm32' not in _info.get_all('Tag', []):
                raise ValueError('Native wheel metadata does not match the target ABI')
        elif _info.get('Root-Is-Purelib', '').lower() != 'true':
            raise ValueError('Pure wheel must declare a pure Python layout')
        for _member in _wheel.infolist():
            _name = _member.filename
            _parts = _name.rstrip('/').split('/')
            if not _name or _name.startswith('/') or '\\' in _name or any(part in ('', '.', '..') for part in _parts):
                raise ValueError(f'Invalid wheel path: {_name}')
            if stat.S_ISLNK(_member.external_attr >> 16):
                raise ValueError(f'Wheel symlinks are unsupported: {_name}')
            if _parts[0] in ('workers', 'workers.py', 'pyodide', '_pyodide'):
                raise ValueError(f'Wheel conflicts with the runtime SDK: {_name}')
            if _parts[0].endswith('.data') or _name.endswith('.pth'):
                raise ValueError(f'Wheel relocation and .pth hooks are unsupported: {_name}')
            if not _member.is_dir():
                if _name in _paths:
                    raise ValueError(f'Wheel file collision: {_name}')
                _paths.add(_name)
                if _name.endswith('.so'):
                    if not _native or _wheel.read(_member)[:8] != b'\x00asm\x01\x00\x00\x00':
                        raise ValueError(f'Extension is not a target Wasm module: {_name}')
                    _native_paths.append(_name)

json.dumps(sorted(_native_paths))
