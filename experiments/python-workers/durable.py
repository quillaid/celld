import json
import asyncio
from js import Response, crypto, fetch
from pyodide.ffi import create_proxy


class Counter:
    def __init__(self, ctx, env):
        self.ctx = ctx
        self.env = env
        self.instance = crypto.randomUUID()
        ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)")
        ctx.storage.sql.exec("INSERT OR IGNORE INTO counter VALUES (1, 0)")

    async def fetch(self, request):
        operation = request.url.rsplit("/", 1)[-1]
        if operation == "abort":
            self.ctx.abort("intentional Python Durable Object abort")
        if operation == "inc":
            self.ctx.storage.sql.exec("UPDATE counter SET value = value + 1 WHERE id = 1")
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
        return Response.new(json.dumps({"value": row.value, "objectInstance": self.instance}))
