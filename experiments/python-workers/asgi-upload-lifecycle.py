import asgi_upload_candidate
import json
from workers import fetch
from workers.asgi import entrypoint


async def app(scope, receive, send):
    if scope['type'] == 'lifespan':
        await receive()
        await send({'type': 'lifespan.startup.complete'})
        await receive()
        await send({'type': 'lifespan.shutdown.complete'})
        return
    await send({'type': 'http.response.start', 'status': 200, 'headers': [(b'content-encoding', b'identity')]})
    if scope['path'] in ('/early', '/partial'):
        if scope['path'] == '/partial':
            assert (await receive())['body'] == b'first\n'
        await send({'type': 'http.response.body', 'body': b'early'})
        return
    gate = dict(scope['headers'])[b'x-gate'].decode()
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
        response = await super().fetch(request)
        if request.url.endswith(('/early', '/partial')):
            body = request.body
            response.headers.set('x-body-locked', 'true' if body and body.locked else 'false')
            if body and not body.locked:
                reader = body.getReader()
                try:
                    response.headers.set('x-body-done', 'true' if (await reader.read()).done else 'false')
                finally:
                    reader.releaseLock()
        return response
