from workers import Response
from workers.asgi import entrypoint


async def app(scope, receive, send):
    if scope['type'] == 'lifespan':
        await receive()
        await send({'type': 'lifespan.startup.complete'})
        await receive()
        await send({'type': 'lifespan.shutdown.complete'})
        return
    await send({'type': 'http.response.start', 'status': 200,
                'headers': [(b'content-type', b'text/plain'), (b'content-encoding', b'identity')]})
    while True:
        event = await receive()
        if event['type'] == 'http.disconnect':
            return
        more = event.get('more_body', False)
        await send({'type': 'http.response.body', 'body': event.get('body', b''), 'more_body': more})
        if not more:
            return


class Default(entrypoint(app)):
    async def fetch(self, request):
        if request.url.endswith('/direct'):
            return Response(request.body, headers={'content-type': 'text/plain', 'content-encoding': 'identity'})
        return await super().fetch(request)
