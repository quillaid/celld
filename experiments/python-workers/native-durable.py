from workers import DurableObject, WorkerEntrypoint, Response
from js import Date, crypto
import hashlib
import workers.entrypoints


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        return await self.env.COUNTER.getByName('counter').fetch(request)


class Counter(DurableObject):
    def __init__(self, ctx, env):
        super().__init__(ctx, env)
        self.instance = str(crypto.randomUUID())
        with open(workers.entrypoints.__file__, 'rb') as sdk_source:
            self.sdk = hashlib.sha256(sdk_source.read()).hexdigest()
        self.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY, value INTEGER, fires INTEGER)')
        self.ctx.storage.sql.exec('INSERT OR IGNORE INTO counter VALUES (1, 0, 0)')

    async def fetch(self, request):
        operation = await request.text()
        if operation == 'inc':
            self.ctx.storage.sql.exec('UPDATE counter SET value = value + 1')
        elif operation == 'rollback':
            def change_and_fail():
                self.ctx.storage.sql.exec('UPDATE counter SET value = value + 1000')
                raise ValueError('native SDK rollback')
            self.ctx.storage.transactionSync(change_and_fail)
        elif operation == 'arm':
            await self.ctx.storage.setAlarm(Date.now() + 100)
        elif operation == 'abort':
            self.ctx.abort('native SDK abort')
        row = self.ctx.storage.sql.exec('SELECT value, fires FROM counter').toArray()[0]
        return Response.from_json({'value': row.value, 'fires': row.fires, 'instance': self.instance, 'sdk': self.sdk})

    async def alarm(self, info):
        self.ctx.storage.sql.exec('UPDATE counter SET fires = fires + 1')
