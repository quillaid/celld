from workers import WorkerEntrypoint, Response

class Default(WorkerEntrypoint):
    async def fetch(self, request):
        body = await request.text()
        if body == 'sdk-identity':
            import hashlib
            import workers.entrypoints
            with open(workers.entrypoints.__file__, 'rb') as source_file:
                digest = hashlib.sha256(source_file.read()).hexdigest()
            return Response.from_json({'entrypoints_sha256': digest})
        if body == 'background':
            async def save():
                await self.env.CACHE.put('sdk-background', 'saved')
            self.ctx.waitUntil(save())
            return Response('scheduled', status=202)
        if body == 'read-background':
            return Response(await self.env.CACHE.get('sdk-background') or 'missing')
        if body == 'binary':
            return Response(bytes([0, 1, 127, 255]), headers={'x-sdk': '1.9.0'})
        return Response.from_json({'body': body, 'method': request.method}, status=201, headers={'x-sdk': '1.9.0'})

# Adapter seam: use the SDK's actual request and response conversions.
async def dispatch_sdk(request, env, ctx):
    from workers import Request
    instance = Default(ctx, env)
    return (await instance.fetch(Request(request))).js_object
