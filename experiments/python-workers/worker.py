import json
import sys
from js import Response, fetch


async def handle(request, env):
    body = await request.text()
    if body == "raise":
        raise ValueError("intentional Python traceback")
    if body == "spin":
        while True:
            pass
    if body == "allocate":
        scratch = bytearray(16 * 1024 * 1024)
        scratch[0] = 1
        scratch[-1] = 2
        assert scratch[0] + scratch[-1] == 3
    if body == "binding":
        await env.CACHE.put("python-probe", "written from Python")
        stored = await env.CACHE.get("python-probe")
    else:
        stored = None
    outbound = None
    if body == "fetch":
        response = await fetch(request.headers.get("x-echo-url"))
        outbound = await response.text()
    return Response.new(json.dumps({
        "language": "python",
        "version": sys.version.split()[0],
        "body": body,
        "binding": stored,
        "outbound": outbound,
    }))
