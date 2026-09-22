from workers import DurableObject, WorkerEntrypoint, Response
from js import crypto

finalized = 0


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        return Response('loaded Python runtime')


class Counter(DurableObject):
    def __init__(self, ctx, env):
        super().__init__(ctx, env)
        self.armed = False
        self.instance = str(crypto.randomUUID())
        self.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS writes (value INTEGER)')

    async def fetch(self, request):
        command = await request.text()
        if command == 'arm':
            self.armed = True
        if command == 'write':
            self.ctx.storage.sql.exec('INSERT INTO writes VALUES (1)')
        count = self.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM writes').toArray()[0].n
        return Response.from_json({'instance': self.instance, 'count': count, 'finalized': finalized})

    def __del__(self):
        global finalized
        finalized += 1
        if self.armed:
            while True:
                pass
