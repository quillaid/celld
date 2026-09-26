"""Python side of the host adapter in python-host.js.

The module owns session namespaces and execution bookkeeping. It never touches
host objects. The JavaScript adapter calls the functions below, and each result
is a plain dict that converts to JSON.

Interruption has two paths:

* Suspended execution: an execution that waits in ``await`` is cancelled
  through ``asyncio.Task.cancel``, which works in any host.
* Running execution: an execution that runs synchronously gets a real
  KeyboardInterrupt from CPython's Emscripten signal check. This path needs a
  host that can write the signal buffer from another thread.

The SIGINT handler below routes each signal to its target execution. A signal
that arrives while the event loop runs its own callbacks must not raise into
the loop, because the pinned interpreter then loses the pending task (see
probes/interrupt-mechanism.mjs).
"""

import asyncio
import contextvars
import gc
import io
import signal
import sys
import traceback

from pyodide.code import eval_code_async

INTERRUPT_MESSAGE = "python-host: interrupt requested"
MAX_REPR = 64 * 1024
MAX_STREAM = 1024 * 1024

_sessions = {}
_executions = {}
_next_execution = 0
_current = contextvars.ContextVar("python_host_execution", default=None)
_signal_target = None  # set by the adapter: callable returning target id


class _Stream(io.TextIOBase):
    """Route writes to the buffer of the execution that runs in this context."""

    def __init__(self, name, fallback):
        self._name = name
        self._fallback = fallback

    def writable(self):
        return True

    def write(self, text):
        execution = _current.get()
        if execution is None:
            return self._fallback.write(text)
        buffer = execution.streams[self._name]
        if buffer.tell() < MAX_STREAM:
            buffer.write(text[: MAX_STREAM - buffer.tell()])
        return len(text)

    def flush(self):
        pass


class Execution:
    def __init__(self, session_id, code):
        global _next_execution
        _next_execution += 1
        self.id = _next_execution
        self.session_id = session_id
        self.code = code
        self.streams = {"stdout": io.StringIO(), "stderr": io.StringIO()}
        self.interrupt_requested = False
        self.task = None


def _session(session_id):
    namespace = _sessions.get(session_id)
    if namespace is None:
        namespace = {"__name__": "__main__", "__builtins__": __builtins__}
        _sessions[session_id] = namespace
        namespace["__python_host_count__"] = 0
    return namespace


def _format_error(error, filename):
    report = traceback.TracebackException.from_exception(error)
    # Drop adapter and Pyodide frames before the first frame of executed code.
    frames = list(report.stack)
    first = next((i for i, frame in enumerate(frames) if frame.filename == filename), len(frames))
    # The SIGINT handler's own frame is adapter code as well.
    frames = [frame for frame in frames[first:] if frame.filename != __file__]
    report.stack = traceback.StackSummary.from_list(frames)
    return {
        "type": type(error).__name__,
        "message": str(error),
        "traceback": "".join(report.format()),
    }


def _finish(execution, status, value=None, error=None):
    _executions.pop(execution.id, None)
    return {
        "status": status,
        "execution": execution.id,
        "session": execution.session_id,
        "count": _session(execution.session_id)["__python_host_count__"],
        "value": value,
        "error": error,
        "stdout": execution.streams["stdout"].getvalue(),
        "stderr": execution.streams["stderr"].getvalue(),
    }


async def _run(execution):
    _current.set(execution)
    namespace = _session(execution.session_id)
    namespace["__python_host_count__"] += 1
    filename = f"<session {execution.session_id} #{namespace['__python_host_count__']}>"
    try:
        value = await eval_code_async(execution.code, namespace, filename=filename)
    except KeyboardInterrupt as error:
        return _finish(execution, "interrupted", error=_format_error(error, filename))
    except asyncio.CancelledError as error:
        if not execution.interrupt_requested:
            raise
        interrupted = KeyboardInterrupt()
        interrupted.__traceback__ = error.__traceback__
        return _finish(execution, "interrupted", error=_format_error(interrupted, filename))
    except BaseException as error:  # SystemExit and friends are notebook content errors
        return _finish(execution, "error", error=_format_error(error, filename))
    rendered = None
    if value is not None:
        rendered = repr(value)
        if len(rendered) > MAX_REPR:
            rendered = rendered[:MAX_REPR] + "..."
    return _finish(execution, "ok", value=rendered)


def execute(session_id, code):
    """Start one execution. Returns (execution id, task); await the task."""
    execution = Execution(session_id, code)
    _executions[execution.id] = execution
    # A fresh context isolates this execution's stream routing.
    execution.task = asyncio.ensure_future(_run(execution), loop=asyncio.get_event_loop())
    return execution.id, execution.task


def interrupt(session_id):
    """Interrupt the executions of one session that wait in ``await``.

    The caller runs on the host thread, so these executions cannot be running
    synchronously at this point.
    """
    interrupted = []
    for execution in list(_executions.values()):
        if execution.session_id == session_id and not execution.task.done():
            execution.interrupt_requested = True
            execution.task.cancel(INTERRUPT_MESSAGE)
            interrupted.append(execution.id)
    return interrupted


def _on_sigint(signum, frame):
    # Target 0 means "whatever runs now". The host writes a target id when it
    # knows which session requested the interrupt.
    target = _signal_target() if _signal_target else 0
    running = _current.get()
    try:
        task = asyncio.current_task()
    except RuntimeError:
        task = None
    if running is not None and task is running.task and target in (0, running.id):
        running.interrupt_requested = True
        raise KeyboardInterrupt
    # The signal arrived between steps, or while another execution ran. Never
    # raise into foreign code; cancel the target at its next await instead.
    for execution in list(_executions.values()):
        if target in (0, execution.id) and not execution.task.done():
            execution.interrupt_requested = True
            execution.task.cancel(INTERRUPT_MESSAGE)


def install(signal_target=None, entries=None):
    global _signal_target
    _signal_target = signal_target
    if entries is not None:
        # Mark every event-loop callback as a Python entry (see python-host.js).
        # A host termination skips this finally block, leaving the mark set.
        original = asyncio.events.Handle._run

        def _run(self):
            entries[0] = entries[0] + 1
            try:
                return original(self)
            finally:
                entries[0] = entries[0] - 1

        asyncio.events.Handle._run = _run
    sys.stdout = _Stream("stdout", sys.__stdout__)
    sys.stderr = _Stream("stderr", sys.__stderr__)
    signal.signal(signal.SIGINT, _on_sigint)


def bind(session_id, name, value):
    """Expose one host object to a session under an explicit name."""
    if not name.isidentifier() or name.startswith("__"):
        raise ValueError(f"invalid binding name: {name!r}")
    _session(session_id)[name] = value


def session_info(session_id):
    namespace = _sessions.get(session_id)
    if namespace is None:
        return None
    names = sorted(k for k in namespace if not k.startswith("__"))
    return {"count": namespace["__python_host_count__"], "names": names}


def running_execution(session_id):
    for execution in _executions.values():
        if execution.session_id == session_id and not execution.task.done():
            return execution.id
    return 0


def dispose(session_id):
    for execution in list(_executions.values()):
        if execution.session_id == session_id and not execution.task.done():
            execution.task.cancel("python-host: session disposed")
    existed = _sessions.pop(session_id, None) is not None
    gc.collect()
    return existed
