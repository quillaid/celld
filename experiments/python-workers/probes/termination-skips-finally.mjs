// Does V8 termination (celld ctx.abort() on a direct event) run JS catch/finally?
// The python-host entry marker relies on the answer being "no".
import { startCelld } from '../local-celld.mjs';
const src = `
let log = [];
export class O { constructor(ctx){ this.ctx = ctx; }
  async fetch(req) {
    const op = new URL(req.url).pathname.split('/').pop();
    if (op === 'abort') { try { log.push('try'); this.ctx.abort('x'); log.push('after'); } catch (e) { log.push('catch'); } finally { log.push('finally'); } return new Response('unreachable'); }
    return Response.json(log);
  } }
export default { fetch(req, env) { return env.O.getByName('o').fetch(req); } };`;
const local = await startCelld({ 'index.js': src }, { durable_objects: { bindings: [{ name: 'O', class_name: 'O' }] }, migrations: [{ tag: 'v1', new_sqlite_classes: ['O'] }] });
try {
  const a = await fetch(local.url + '/abort'); console.log('abort', a.status, (await a.text()).slice(0, 120));
  console.log('log', await (await fetch(local.url + '/log')).text());
} finally { await local.close(); }
