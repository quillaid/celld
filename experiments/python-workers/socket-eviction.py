from workers import DurableObject, WorkerEntrypoint, Response
from js import WebSocketPair, WebSocketRequestResponsePair, Object, crypto
from pyodide.ffi import to_js
import json


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        return await self.env.COUNTER.getByName('eviction').fetch(request)


class Counter(DurableObject):
    def __init__(self, ctx, env):
        super().__init__(ctx, env)
        self.instance = str(crypto.randomUUID())
        self.restored = len(self.ctx.getWebSockets())
        self.ctx.setWebSocketAutoResponse(WebSocketRequestResponsePair.new('ping', 'pong'))
        self.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS messages (value TEXT)')

    async def fetch(self, request):
        client, server = Object.values(WebSocketPair.new())
        self.ctx.acceptWebSocket(server, to_js(['python']))
        server.serializeAttachment(request.url.rsplit('/', 1)[-1])
        return Response(status=101, web_socket=client)

    async def webSocketMessage(self, socket, message):
        self.ctx.storage.sql.exec('INSERT INTO messages VALUES (?)', message)
        count = self.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM messages').toArray()[0].n
        auto_timestamp = self.ctx.getWebSocketAutoResponseTimestamp(socket)
        socket.send(json.dumps({
            'instance': self.instance, 'restored': self.restored,
            'attachment': socket.deserializeAttachment(),
            'tags': list(self.ctx.getTags(socket)),
            'count': count, 'message': message,
            'auto_timestamp': auto_timestamp.getTime() if auto_timestamp else None,
            'scope': 'Counter:' + str(self.ctx.id),
        }))

    async def webSocketClose(self, socket, code, reason, clean):
        if code != 1006:
            socket.close(code, reason)
