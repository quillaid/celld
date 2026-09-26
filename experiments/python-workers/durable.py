import json
import asyncio
from js import Response, crypto, fetch, Date
from pyodide.ffi import create_proxy


class Counter:
    def __init__(self, ctx, env):
        self.ctx = ctx
        self.env = env
        self.instance = crypto.randomUUID()
        ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)")
        ctx.storage.sql.exec("INSERT OR IGNORE INTO counter VALUES (1, 0)")
        ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS alarms (id INTEGER PRIMARY KEY, fires INTEGER NOT NULL)")
        ctx.storage.sql.exec("INSERT OR IGNORE INTO alarms VALUES (1, 0)")

    async def alarm(self, info):
        self.ctx.storage.sql.exec("UPDATE alarms SET fires = fires + 1 WHERE id = 1")

    async def fetch(self, request):
        operation = request.url.rsplit("/", 1)[-1]
        if operation == "abort":
            self.ctx.abort("intentional Python Durable Object abort")
        if operation == "inc":
            self.ctx.storage.sql.exec("UPDATE counter SET value = value + 1 WHERE id = 1")
        if operation == "rollback":
            def change_and_fail():
                self.ctx.storage.sql.exec("UPDATE counter SET value = value + 1000 WHERE id = 1")
                raise ValueError("intentional transaction rollback")
            callback = create_proxy(change_and_fail)
            try:
                self.ctx.storage.transactionSync(callback)
            finally:
                callback.destroy()
        if operation == "arm":
            delay = int(request.headers.get("x-alarm-delay") or "100")
            await self.ctx.storage.setAlarm(Date.now() + delay)
        if operation == "block":
            async def hold():
                await fetch(request.headers.get("x-ready-url"))
                await asyncio.sleep(60)
            callback = create_proxy(hold)
            try:
                await self.ctx.blockConcurrencyWhile(callback)
            finally:
                callback.destroy()
        row = self.ctx.storage.sql.exec("SELECT value FROM counter WHERE id = 1").toArray()[0]
        alarms = self.ctx.storage.sql.exec("SELECT fires FROM alarms WHERE id = 1").toArray()[0]
        return Response.new(json.dumps({"value": row.value, "objectInstance": self.instance,
                                       "fires": alarms.fires, "alarmAt": await self.ctx.storage.getAlarm()}))
