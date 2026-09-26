# Adapter for workerd's pinned 0.28.2 Python bundle and historical SDK.
# Shared application source lives in worker.py without runtime-specific edits.
from workers import WorkerEntrypoint
from worker import handle


class Default(WorkerEntrypoint):
    async def on_fetch(self, request):
        return await handle(request, self.env)
