import hashlib
import ssl
import _ssl
import pydantic_core._pydantic_core as core
from fastapi import FastAPI, Depends, BackgroundTasks
from pydantic import BaseModel, Field
from workers.asgi import entrypoint

app = FastAPI()
completed = {}

def sync_dependency():
    import threading
    return threading.current_thread() is threading.main_thread()

@app.get('/sync/{value}')
def sync_route(value: int, on_main_thread: bool = Depends(sync_dependency)):
    return {'value': value * 2, 'on_main_thread': on_main_thread}

def finish_background(value):
    completed[value] = 'complete'

@app.post('/background/{value}')
async def start_background(value: int, background_tasks: BackgroundTasks):
    background_tasks.add_task(finish_background, value)
    return {'accepted': value}

@app.get('/background/{value}')
async def read_background(value: int):
    return {'state': completed.get(value, 'pending')}

class Item(BaseModel):
    name: str
    count: int = Field(gt=0)

@app.post('/items/{item_id}', status_code=201)
async def create_item(item_id: int, item: Item, scale: int = 1):
    return {'id': item_id, 'item': item.model_dump(), 'total': item.count * scale}

@app.get('/runtime')
async def runtime():
    import anyio.to_thread
    import _workers_sdk_package_patches
    with open(_workers_sdk_package_patches.__file__, 'rb') as source:
        patch_digest = hashlib.sha256(source.read()).hexdigest()
    with open(core.__file__, 'rb') as source:
        digest = hashlib.sha256(source.read()).hexdigest()
    with open(_ssl.__file__, 'rb') as source:
        ssl_digest = hashlib.sha256(source.read()).hexdigest()
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    return {'openssl': ssl.OPENSSL_VERSION, 'core_sha256': digest, 'ssl_sha256': ssl_digest,
            'thread_patch': anyio.to_thread.run_sync.__module__, 'patch_sha256': patch_digest,
            'verify_mode': int(context.verify_mode), 'check_hostname': context.check_hostname}

Default = entrypoint(app)
