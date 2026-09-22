"""Host adapter; application modules contain only ordinary Workers SDK code."""
import importlib
import inspect
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
