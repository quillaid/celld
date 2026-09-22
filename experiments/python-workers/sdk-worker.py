from workers import WorkerEntrypoint, Response

class Default(WorkerEntrypoint):
    async def fetch(self, request):
        if request.headers.get('x-observe-upload') == '1':
            import asyncio
            import json
            from workers import fetch
            report_url = request.headers.get('x-release-url')
            async def consume():
                reader = request.body.getReader()
                outcome = {'outcome': 'eof', 'bytes': 0, 'stage': 'read'}
                try:
                    while True:
                        outcome['stage'] = 'read'
                        item = await reader.read()
                        if item.done:
                            break
                        outcome['bytes'] += item.value.byteLength
                        if outcome['bytes'] == 6:
                            outcome['stage'] = 'notify'
                            started = await fetch(report_url + '/started')
                            await started.text()
                except Exception as error:
                    outcome['outcome'] = 'rejected'
                    outcome['error'] = str(error)
                finally:
                    reader.releaseLock()
                    reported = await fetch(report_url + '/done', method='POST', body=json.dumps(outcome))
                    await reported.text()
                return outcome
            task = asyncio.create_task(consume())
            self.ctx.waitUntil(task)
            return Response.from_json(await task)
        if request.headers.get('x-echo-upload') == '1':
            return Response(request.body, headers={'content-type': 'text/plain'})
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
        if body in ('stream', 'cancel-stream'):
            from js import TransformStream, TextEncoder
            from workers import fetch
            stream = TransformStream.new()
            writer = stream.writable.getWriter()
            encoder = TextEncoder.new()
            release_url = request.headers.get('x-release-url')
            async def produce():
                outcome = {'outcome': 'completed', 'writes': 0, 'stage': 'prefix'}
                try:
                    await writer.write(encoder.encode('first\n'))
                    outcome['stage'] = 'release'
                    released = await fetch(release_url)
                    await released.text()
                    outcome['stage'] = 'writes'
                    if body == 'cancel-stream':
                        chunk = encoder.encode('x' * 65536)
                        for _ in range(256):
                            await writer.write(chunk)
                            outcome['writes'] += 1
                    else:
                        await writer.write(encoder.encode('second\n'))
                    outcome['stage'] = 'close'
                    await writer.close()
                except Exception as error:
                    if body != 'cancel-stream':
                        raise
                    outcome['outcome'] = 'rejected'
                    outcome['error'] = str(error)
                finally:
                    writer.releaseLock()
                    if body == 'cancel-stream':
                        import json
                        reported = await fetch(release_url + '/done', method='POST', body=json.dumps(outcome))
                        await reported.text()
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
