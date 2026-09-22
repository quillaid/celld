from workers import DurableObject, WorkerEntrypoint, Response
from js import crypto


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        name = request.url.rsplit('/', 1)[-1] or 'pressure'
        return await self.env.COUNTER.getByName(name).fetch(request)


class Counter(DurableObject):
    def __init__(self, ctx, env):
        super().__init__(ctx, env)
        self.instance = str(crypto.randomUUID())
        self.buffers = []
        self.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS writes (value INTEGER)')

    async def fetch(self, request):
        command = await request.text()
        if command == 'allocate':
            self.buffers.append(bytearray(b'x') * (256 * 1024 * 1024))
            self.ctx.storage.sql.exec('INSERT INTO writes VALUES (1)')
        count = self.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM writes').toArray()[0].n
        return Response.from_json({'instance': self.instance, 'count': count, 'allocated': sum(map(len, self.buffers)), 'scope': 'Counter:' + str(self.ctx.id)})
