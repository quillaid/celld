"""Host adapter; application modules contain only ordinary Workers SDK code."""
import importlib
import inspect
from types import FunctionType
from workers import WorkerEntrypoint, python_from_rpc, python_to_rpc


def load_worker(module_name, class_name):
    module = importlib.import_module(module_name)
    entrypoint = getattr(module, class_name)
    if not isinstance(entrypoint, type) or not issubclass(entrypoint, WorkerEntrypoint):
        raise TypeError(f'{module_name}.{class_name} must extend workers.WorkerEntrypoint')

    async def dispatch(ctx, env, method_name, *arguments):
        instance = entrypoint(ctx, env)
        method = getattr(instance, method_name)
        result = method(*(python_from_rpc(argument) for argument in arguments))
        if inspect.isawaitable(result):
            result = await result
        return python_to_rpc(result)

    return dispatch


def load_durable(module_name, class_name, ctx, env):
    from workers import DurableObject
    entrypoint = getattr(importlib.import_module(module_name), class_name)
    if not isinstance(entrypoint, type) or not issubclass(entrypoint, DurableObject):
        raise TypeError(f'{module_name}.{class_name} must extend workers.DurableObject')
    instance = entrypoint(ctx, env)

    async def dispatch(method_name, *arguments):
        method = getattr(instance, method_name)
        # workerd sends lifecycle events directly through Pyodide's FFI. RPC
        # conversion would turn a binary WebSocket ArrayBuffer into a memoryview,
        # changing the event API before the application can inspect it.
        if method_name in ('alarm', 'webSocketMessage', 'webSocketClose', 'webSocketError'):
            result = method(*arguments)
        else:
            result = method(*(python_from_rpc(argument) for argument in arguments))
        if inspect.isawaitable(result):
            result = await result
        return python_to_rpc(result)

    # Discover methods without invoking properties. A leading underscore is
    # not an RPC access boundary in workerd. Include instance-installed functions
    # and static/class methods; arbitrary late-added callables remain unsupported.
    dispatch.rpc_methods = [
        name for name in dir(instance)
        if not name.startswith('__')
        and isinstance(inspect.getattr_static(instance, name), (FunctionType, staticmethod, classmethod))
    ]
    return dispatch
