"""Validate syntax and unconditional module imports without running app code.

Conditional, function-local, dynamic and imported-attribute resolution remains
runtime behavior. This pass never imports an application module to inspect it.
"""
import ast
import importlib.machinery
import importlib.util
import json
import sys

sources = json.loads(_celld_sources_json)
for filename, source in sources.items():
    compile(source, filename, 'exec', dont_inherit=True)


def find_module(name):
    """Walk specs directly; util.find_spec would execute parent packages."""
    parts = name.split('.')
    # Builtin/frozen modules can expose virtual children (e.g. os.path).
    if parts[0] in sys.stdlib_module_names or parts[0] == 'js':
        return True
    path = ['/app', '/sdk', '/packages', *sys.path]
    for index in range(len(parts)):
        # Inspect one directory component at a time. A qualified namespace
        # spec consults parent modules in sys.modules, which would require
        # executing the application package we deliberately have not imported.
        spec = importlib.machinery.PathFinder.find_spec(parts[index], path)
        if spec is None:
            return False
        if index < len(parts) - 1:
            if spec.submodule_search_locations is None:
                return False
            path = spec.submodule_search_locations
    return True


for filename, source in sources.items():
    package = filename.rsplit('/', 1)[0].replace('/', '.') if '/' in filename else ''
    for statement in ast.parse(source, filename).body:
        names = []
        if isinstance(statement, ast.Import):
            names = [alias.name for alias in statement.names]
        elif isinstance(statement, ast.ImportFrom):
            name = statement.module or ''
            if statement.level:
                if not package:
                    raise ImportError(f'{filename}:{statement.lineno}: relative import outside a package')
                name = importlib.util.resolve_name('.' * statement.level + name, package)
            names = [name]
        for name in names:
            if not find_module(name):
                raise ModuleNotFoundError(f'{filename}:{statement.lineno}: module {name!r} is not bundled')
