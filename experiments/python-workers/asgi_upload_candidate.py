"""Test-only SDK upload candidate; not installed by the celld runtime.

Keep the released response/lifespan code and replace only eager body collection
with demand-driven receive. Cancellation and unread-body cleanup remain gates
before this can become a supported SDK overlay.
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
    body_iterator = request_body.__aiter__() if request_body else None
    body_complete = False

    async def receive():
        nonlocal body_complete
        if not body_complete:
            if body_iterator is not None:
                try:
                    data = await anext(body_iterator)
                except StopAsyncIteration:
                    body_complete = True
                else:
                    return {"type": "http.request", "body": data.to_bytes(), "more_body": True}
            body_complete = True
            return {"type": "http.request", "body": b"", "more_body": False}
        await finished_response.wait()
        return {"type": "http.disconnect"}
'''
source = inspect.getsource(asgi.process_request)
if source.count(before) != 1:
    raise RuntimeError('ASGI upload candidate source anchor changed')
exec(compile(source.replace(before, after), '<celld-asgi-upload-candidate>', 'exec'), asgi.__dict__)
