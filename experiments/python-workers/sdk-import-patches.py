"""Host import bridge for the pinned SDK's non-snapshot package patches.

The SDK owns the package adaptations. This bridge supplies register_exec_patch
and wraps application imports; it does not emulate snapshot entropy lifecycle.
"""
import importlib
import importlib.machinery
import importlib.util
import sys
from contextlib import contextmanager

_sdk_exec_patches = {}


def _register_sdk_exec_patch(name, context_manager=None):
    if context_manager is None:
        return lambda manager: _register_sdk_exec_patch(name, manager)
    _sdk_exec_patches[name] = context_manager
    return context_manager


class _SdkPatchLoader:
    def __init__(self, original, patch):
        self.original = original
        self.patch = patch

    def __getattr__(self, name):
        return getattr(self.original, name)

    def create_module(self, spec):
        create = getattr(self.original, 'create_module', None)
        return create(spec) if create else None

    def exec_module(self, module):
        with self.patch(module):
            self.original.exec_module(module)


class _SdkPatchFinder:
    def find_spec(self, fullname, path=None, target=None):
        patch = _sdk_exec_patches.get(fullname)
        if patch is None:
            return None
        for finder in tuple(sys.meta_path):
            if isinstance(finder, _SdkPatchFinder):
                continue
            spec = finder.find_spec(fullname, path, target)
            if spec is None:
                continue
            if spec.loader is None or not hasattr(spec.loader, 'exec_module'):
                raise ImportError(f'SDK exec patch requires an executable loader: {fullname}')
            spec.loader = _SdkPatchLoader(spec.loader, patch)
            return spec
        return None


@contextmanager
def _sdk_package_imports():
    # A distinct finder per scope makes nested imports and exception cleanup
    # independent. Never remove another importer's meta-path entry.
    finder = _SdkPatchFinder()
    sys.meta_path.insert(0, finder)
    try:
        yield
    finally:
        if finder in sys.meta_path:
            sys.meta_path.remove(finder)


def _load_application(module_name):
    with _sdk_package_imports():
        return importlib.import_module(module_name)


_cloudflare_package = importlib.util.module_from_spec(
    importlib.machinery.ModuleSpec('_cloudflare', loader=None, is_package=True)
)
_patch_module = importlib.util.module_from_spec(
    importlib.machinery.ModuleSpec('_cloudflare.import_patch_manager', loader=None)
)
_patch_module.register_exec_patch = _register_sdk_exec_patch
_cloudflare_package.import_patch_manager = _patch_module
sys.modules['_cloudflare'] = _cloudflare_package
sys.modules['_cloudflare.import_patch_manager'] = _patch_module
# Load this exact module from the verified SDK wheel. Its .pth loader also
# enables snapshot entropy patches, which do not apply to this request-time
# initialization path and are intentionally not imported here.
_sdk_patch_spec = importlib.util.spec_from_file_location(
    '_workers_sdk_package_patches', '/sdk/_workers_sdk_package_patches.py'
)
_sdk_patch_code = importlib.util.module_from_spec(_sdk_patch_spec)
sys.modules[_sdk_patch_spec.name] = _sdk_patch_code
try:
    _sdk_patch_spec.loader.exec_module(_sdk_patch_code)
except BaseException:
    sys.modules.pop(_sdk_patch_spec.name, None)
    raise
