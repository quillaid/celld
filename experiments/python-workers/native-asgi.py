from workers.asgi import entrypoint
from workers import env
import asyncio
import json


async def app(scope, receive, send):
    if scope['type'] == 'lifespan':
        assert (await receive())['type'] == 'lifespan.startup'
        scope['state']['startup'] = 'ready'
        scope['state']['tracker'] = {'id': None}
        await send({'type': 'lifespan.startup.complete'})
        assert (await receive())['type'] == 'lifespan.shutdown'
        request_id = scope['state']['tracker']['id']
        if request_id is not None:
            await env.RESULTS.put(request_id, 'closed')
        await send({'type': 'lifespan.shutdown.complete'})
        return
    if scope['path'] == '/shutdown':
        value = await env.RESULTS.get(scope['query_string'].decode())
        await send({'type': 'http.response.start', 'status': 200, 'headers': []})
        await send({'type': 'http.response.body', 'body': (value or 'pending').encode()})
        return
    scope['state']['tracker']['id'] = scope['query_string'].decode()
    body = bytearray()
    while True:
        event = await receive()
        assert event['type'] == 'http.request'
        body.extend(event.get('body', b''))
        if not event.get('more_body', False):
            break
    result = json.dumps({'path': scope['path'], 'query': scope['query_string'].decode(), 'body': body.decode(), 'state': {'startup': scope['state']['startup']}}).encode()
    await send({'type': 'http.response.start', 'status': 201, 'headers': [(b'content-type', b'application/json'), (b'x-asgi', b'python')]})
    await send({'type': 'http.response.body', 'body': result[:10], 'more_body': True})
    await asyncio.sleep(0.01)
    await send({'type': 'http.response.body', 'body': result[10:], 'more_body': False})


Default = entrypoint(app)
