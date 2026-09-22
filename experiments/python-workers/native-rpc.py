from workers import DurableObject, WorkerEntrypoint, Response
import asyncio


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        data = await request.json()
        stub = self.env.COUNTER.getByName(data.get('name', 'rpc-counter'))
        operation = data['operation']
        if operation == 'increment':
            result = await stub.increment(data['amount'])
        elif operation == 'echo':
            result = await stub.echo(data['payload'])
        elif operation == 'inherited':
            result = await stub.inherited(data['value'])
        elif operation == 'fail':
            result = await stub.fail()
        elif operation == 'private':
            result = await stub._secret()
        elif operation == 'static':
            result = await stub.static_method(data['value'])
        elif operation == 'class':
            result = await stub.class_method()
        elif operation == 'installed':
            result = await stub.installed(data['value'])
        else:
            result = await stub.read()
        return Response.from_json(result)


class Methods:
    def inherited(self, value):
        return {'inherited': value}


class Counter(Methods, DurableObject):
    def __init__(self, ctx, env):
        super().__init__(ctx, env)
        self.installed = lambda value: {'installed': value}
        self.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS counter (value INTEGER)')
        self.ctx.storage.sql.exec('INSERT INTO counter SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM counter)')

    def read(self):
        return {'value': self.ctx.storage.sql.exec('SELECT value FROM counter').toArray()[0].value}

    def increment(self, amount):
        self.ctx.storage.sql.exec('UPDATE counter SET value = value + ?', amount)
        return self.read()

    async def echo(self, payload):
        await asyncio.sleep(0.005)
        return {'payload': payload, 'value': self.read()['value']}

    def fail(self):
        raise ValueError('Python RPC failure')

    def _secret(self):
        return {'private': 'visible'}

    @staticmethod
    def static_method(value):
        return {'static': value}

    @classmethod
    def class_method(cls):
        return {'class': cls.__name__}
