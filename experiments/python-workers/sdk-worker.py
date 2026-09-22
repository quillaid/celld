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
        if body == 'raise':
            raise ValueError('SDK application exception')
        if body.startswith('concurrent:'):
            import asyncio
            self.body = body
            await asyncio.sleep(0.01)
            return Response(self.body)
        if body == 'stream':
            from js import TransformStream, TextEncoder
            from workers import fetch
            stream = TransformStream.new()
            writer = stream.writable.getWriter()
            encoder = TextEncoder.new()
            release_url = request.headers.get('x-release-url')
            async def produce():
                try:
                    await writer.write(encoder.encode('first\n'))
                    released = await fetch(release_url)
                    await released.text()
                    await writer.write(encoder.encode('second\n'))
                    await writer.close()
                finally:
                    writer.releaseLock()
            self.ctx.waitUntil(produce())
            return Response(stream.readable, headers={'content-type': 'text/plain'})
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
