"""Test-only SDK upload candidate; not installed by the celld runtime.

Keep the released response/lifespan paths while reading the body on demand and
closing owned input readers on application exit. Receive-only disconnect and
response-completion races remain gates before a supported SDK overlay.
"""
import hashlib
import inspect
from pathlib import Path
import workers.asgi as asgi

BASE_SHA256 = 'f606250b2087c7bfffcdcae8a9dd95f080954820e457e932daa77803c4fdd35d'
if hashlib.sha256(Path(asgi.__file__).read_bytes()).hexdigest() != BASE_SHA256:
    raise RuntimeError('ASGI upload candidate requires the exact pinned SDK source')

before = '''    receive_queue = Queue()
    if req.body:
        async for data in req.body:
            await receive_queue.put(
                {
                    "body": data.to_bytes(),
                    "more_body": True,
                    "type": "http.request",
                }
            )
    await receive_queue.put({"body": b"", "more_body": False, "type": "http.request"})

    async def receive():
        message = None
        if not receive_queue.empty():
            message = await receive_queue.get()
        else:
            await finished_response.wait()
            message = {"type": "http.disconnect"}
        return message
'''
after = '''    request_body = req.body
    body_reader = None
    body_complete = False
    body_disconnected = False
    pending_read = None
    from asyncio import Lock, ensure_future, gather, shield
    receive_lock = Lock()

    async def close_request_body():
        nonlocal body_reader, body_complete, pending_read
        try:
            if body_reader is not None:
                if not body_complete:
                    await body_reader.cancel()
            elif request_body and not body_complete:
                await request_body.cancel()
        except Exception:
            # An errored transport can reject cancellation as well as reads.
            pass
        finally:
            if pending_read is not None:
                await gather(pending_read, return_exceptions=True)
                pending_read = None
            if body_reader is not None:
                body_reader.releaseLock()
                body_reader = None
            body_complete = True

    async def receive():
        nonlocal body_reader, body_complete, body_disconnected, pending_read
        async with receive_lock:
            if body_disconnected or finished_response.is_set():
                return {"type": "http.disconnect"}
            if not body_complete:
                if request_body:
                    if body_reader is None:
                        body_reader = request_body.getReader()
                    if pending_read is None:
                        pending_read = ensure_future(body_reader.read())
                    try:
                        # A canceled ASGI receive must not consume a chunk that
                        # the next caller can no longer retrieve.
                        data = await shield(pending_read)
                    except Exception:
                        body_disconnected = True
                        await close_request_body()
                        return {"type": "http.disconnect"}
                    pending_read = None
                    if not data.done:
                        return {"type": "http.request", "body": data.value.to_bytes(), "more_body": True}
                body_complete = True
                await close_request_body()
                return {"type": "http.request", "body": b"", "more_body": False}
            await finished_response.wait()
            return {"type": "http.disconnect"}
'''
source = inspect.getsource(asgi.process_request)
if source.count(before) != 1:
    raise RuntimeError('ASGI upload candidate source anchor changed')
cleanup_anchor = '                    run_in_background(close_stream_quietly(writer))\n'
if source.count(cleanup_anchor) != 1:
    raise RuntimeError('ASGI upload candidate cleanup anchor changed')
source = source.replace(before, after).replace(cleanup_anchor, cleanup_anchor + '        finally:\n            await close_request_body()\n')
exec(compile(source, '<celld-asgi-upload-candidate>', 'exec'), asgi.__dict__)
