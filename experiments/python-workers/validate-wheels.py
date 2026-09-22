"""Validate the supported pure-wheel layout before unpacking any package."""
import email.parser
import stat
import zipfile

_paths = set()
for _index in range(_celld_wheel_count):
    with zipfile.ZipFile(f'/wheel-input/{_index}.whl') as _wheel:
        _metadata = [name for name in _wheel.namelist() if name.endswith('.dist-info/WHEEL')]
        if len(_metadata) != 1:
            raise ValueError('Wheel must contain one WHEEL metadata file')
        _info = email.parser.Parser().parsestr(_wheel.read(_metadata[0]).decode())
        if _info.get('Root-Is-Purelib', '').lower() != 'true':
            raise ValueError('Only pure Python wheel layouts are supported')
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
