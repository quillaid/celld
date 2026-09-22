import hashlib
import ssl
import _ssl
import pydantic_core._pydantic_core as core
from fastapi import FastAPI
from pydantic import BaseModel, Field
from workers.asgi import entrypoint

app = FastAPI()

class Item(BaseModel):
    name: str
    count: int = Field(gt=0)

@app.post('/items/{item_id}', status_code=201)
async def create_item(item_id: int, item: Item, scale: int = 1):
    return {'id': item_id, 'item': item.model_dump(), 'total': item.count * scale}

@app.get('/runtime')
async def runtime():
    with open(core.__file__, 'rb') as source:
        digest = hashlib.sha256(source.read()).hexdigest()
    with open(_ssl.__file__, 'rb') as source:
        ssl_digest = hashlib.sha256(source.read()).hexdigest()
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    return {'openssl': ssl.OPENSSL_VERSION, 'core_sha256': digest, 'ssl_sha256': ssl_digest,
            'verify_mode': int(context.verify_mode), 'check_hostname': context.check_hostname}

Default = entrypoint(app)
