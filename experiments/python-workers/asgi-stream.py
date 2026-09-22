import json
from workers import fetch
from workers.asgi import entrypoint


async def app(scope, receive, send):
    if scope['type'] == 'lifespan':
        await receive()
        scope['state']['tracker'] = {}
        await send({'type': 'lifespan.startup.complete'})
        await receive()
        gate = scope['state']['tracker'].get('gate')
        if gate:
            await (await fetch(gate + '/shutdown', method='POST', body='closed')).text()
        await send({'type': 'lifespan.shutdown.complete'})
        return
    gate = dict(scope['headers'])[b'x-gate'].decode()
    scope['state']['tracker']['gate'] = gate
    await send({'type': 'http.response.start', 'status': 200,
                'headers': [(b'content-type', b'text/plain'), (b'content-encoding', b'identity')]})
    writes = 0
    outcome = 'complete'
    try:
        await send({'type': 'http.response.body', 'body': b'first\n', 'more_body': True})
        await (await fetch(gate)).text()
        if scope['path'] == '/cancel':
            for index in range(256):
                await send({'type': 'http.response.body', 'body': b'x' * 65536, 'more_body': True})
                writes += 1
        await send({'type': 'http.response.body', 'body': b'second\n', 'more_body': False})
    except Exception:
        outcome = 'rejected'
        raise
    finally:
        await (await fetch(gate + '/producer', method='POST', body=json.dumps({'outcome': outcome, 'writes': writes}))).text()


Default = entrypoint(app)
