from workers import DurableObject, WorkerEntrypoint, Response
from js import crypto
import gc
import weakref

instances = weakref.WeakSet()
finalized = 0


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        name = request.url.rsplit('/', 1)[-1]
        return await self.env.COUNTER.getByName(name).fetch(request)


class Counter(DurableObject):
    def __init__(self, ctx, env):
        super().__init__(ctx, env)
        self.instance = str(crypto.randomUUID())
        self.buffer = bytearray(1024 * 1024)
        instances.add(self)

    async def fetch(self, request):
        gc.collect()
        return Response.from_json({'instance': self.instance, 'live': len(instances), 'finalized': finalized, 'scope': 'Counter:' + str(self.ctx.id)})

    def __del__(self):
        global finalized
        finalized += 1
