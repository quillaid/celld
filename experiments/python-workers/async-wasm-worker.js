import compiled from './empty.wasm';
const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

export default {
  async fetch(request) {
    const operation = new URL(request.url).pathname.slice(1);
    if (operation === 'sync') {
      return Response.json({ outcome: 'resolved', instance: new WebAssembly.Instance(compiled) instanceof WebAssembly.Instance });
    }
    try {
      const promise = operation === 'compile' ? WebAssembly.compile(bytes)
        : operation === 'instantiate-bytes' ? WebAssembly.instantiate(bytes)
        : WebAssembly.instantiate(compiled);
      const result = await Promise.race([
        promise.then(() => ({ outcome: 'resolved' }), (error) => ({ outcome: 'rejected', error: String(error) })),
        new Promise((done) => setTimeout(() => done({ outcome: 'timeout' }), 100)),
      ]);
      return Response.json(result);
    } catch (error) {
      return Response.json({ outcome: 'threw', error: String(error) });
    }
  },
};
