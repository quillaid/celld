import asgi_upload_candidate
import json
import asyncio
from workers import fetch
from workers.asgi import entrypoint
from js import Response as JsResponse


async def app(scope, receive, send):
    if scope['type'] == 'lifespan':
        await receive()
        await send({'type': 'lifespan.startup.complete'})
        await receive()
        await send({'type': 'lifespan.shutdown.complete'})
        return
    await send({'type': 'http.response.start', 'status': 200, 'headers': [(b'content-encoding', b'identity')]})
    if scope['path'] in ('/early', '/partial', '/app-error'):
        if scope['path'] in ('/partial', '/app-error'):
            assert (await receive())['body'] == b'first\n'
        if scope['path'] == '/app-error':
            raise ValueError('intentional ASGI application error')
        await send({'type': 'http.response.body', 'body': b'early'})
        return
    gate = dict(scope['headers'])[b'x-gate'].decode()
    if scope['path'] == '/task-cancel':
        cancelled = []
        for _ in range(3):
            pending = asyncio.create_task(receive())
            await asyncio.sleep(0.01)
            cancelled.append(pending.cancel())
            try:
                await pending
            except asyncio.CancelledError:
                pass
        await (await fetch(gate + '/waiting', method='POST')).text()
        chunks = []
        while True:
            event = await receive()
            assert event['type'] == 'http.request'
            chunks.append(event.get('body', b''))
            if not event.get('more_body', False):
                break
        result = json.dumps({'cancelled': cancelled, 'body': b''.join(chunks).decode()}).encode()
        await send({'type': 'http.response.body', 'body': result})
        return
    first = await receive()
    assert first['type'] == 'http.request' and first['body'] == b'first\n'
    await send({'type': 'http.response.body', 'body': b'ready\n', 'more_body': True})
    await (await fetch(gate + '/waiting', method='POST')).text()
    observation = {}
    try:
        event = await receive()
        observation['event'] = event['type']
    except Exception as error:
        observation['error'] = type(error).__name__
    finally:
        await (await fetch(gate + '/finished', method='POST', body=json.dumps(observation))).text()


class Default(entrypoint(app)):
    async def fetch(self, request):
        try:
            response = await super().fetch(request)
        except ValueError as error:
            if str(error) != 'intentional ASGI application error':
                raise
            response = JsResponse.new('app-error', status=500)
        if request.url.endswith(('/early', '/partial', '/app-error', '/task-cancel')):
            body = request.body
            response.headers.set('x-body-locked', 'true' if body and body.locked else 'false')
            if body and not body.locked:
                reader = body.getReader()
                try:
                    response.headers.set('x-body-done', 'true' if (await reader.read()).done else 'false')
                finally:
                    reader.releaseLock()
        return response
