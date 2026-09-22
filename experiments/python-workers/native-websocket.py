from workers import DurableObject, WorkerEntrypoint, Response
from js import WebSocketPair, Object
import asyncio
import json


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        return await self.env.COUNTER.getByName('socket-counter').fetch(request)


class Counter(DurableObject):
    def __init__(self, ctx, env):
        super().__init__(ctx, env)
        self.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS events (kind TEXT, value TEXT)')

    async def fetch(self, request):
        if request.headers.get('Upgrade') != 'websocket':
            rows = self.ctx.storage.sql.exec('SELECT kind, value FROM events ORDER BY rowid').toArray()
            return Response.from_json([{'kind': row.kind, 'value': row.value} for row in rows])
        client, server = Object.values(WebSocketPair.new())
        self.ctx.acceptWebSocket(server)
        server.serializeAttachment('python-session')
        return Response(status=101, web_socket=client)

    async def webSocketMessage(self, socket, message):
        await asyncio.sleep(0.005)
        if isinstance(message, str):
            value = message
        else:
            value = list(message.to_py())
        self.ctx.storage.sql.exec('INSERT INTO events VALUES (?, ?)', 'message', json.dumps(value))
        socket.send(json.dumps({'value': value, 'attachment': socket.deserializeAttachment()}))

    async def webSocketClose(self, socket, code, reason, was_clean):
        self.ctx.storage.sql.exec('INSERT INTO events VALUES (?, ?)', 'close', json.dumps({'code': code, 'reason': reason, 'clean': was_clean}))
        socket.close(code, reason)
