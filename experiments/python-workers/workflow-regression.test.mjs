import test from 'node:test';
import assert from 'node:assert/strict';
import { startCelld } from './local-celld.mjs';

// Exercise both internal Workflow users of transaction views after correcting
// the public zero-argument transactionSync callback contract.
const source = `
import { WorkflowEntrypoint } from 'cloudflare:workers';
export class Probe extends WorkflowEntrypoint {
  async run(event, step) {
    const received = await step.waitForEvent('receive', { type: 'probe', timeout: '1 minute' });
    return await step.do('record', async () => ({ value: received.payload.value }));
  }
}
export default { async fetch(request, env) {
  const operation = new URL(request.url).pathname;
  if (operation === '/create') return Response.json({ id: (await env.PROBES.create({ id: 'probe' })).id });
  const instance = await env.PROBES.get('probe');
  if (operation === '/send') { await instance.sendEvent({ type: 'probe', payload: { value: 42 } }); return new Response('sent'); }
  return Response.json(await instance.status());
} };
`;
test('Workflow event consumption and persisted steps survive transaction API correction', { timeout: 30000 }, async (t) => {
  const local = await startCelld({ 'index.js': source }, {
    workflows: [{ binding: 'PROBES', name: 'transaction-probe', class_name: 'Probe' }],
  });
  t.after(local.close);
  const request = async (path) => {
    const response = await fetch(local.url + path, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200, await response.clone().text());
    return response;
  };
  assert.deepEqual(await (await request('/create')).json(), { id: 'probe' });
  await request('/send');
  const deadline = Date.now() + 15000;
  let status;
  do {
    status = await (await request('/status')).json();
    if (status.status === 'complete' || status.status === 'errored') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.equal(status.status, 'complete', JSON.stringify(status));
  assert.deepEqual(status.output, { value: 42 });
});
