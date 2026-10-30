import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createPreviewServer } from '../tools/preview.mjs';

test('HTTP preview runs the real backend: writes, retries without duplicates and rejects invalid input', async () => {
  const { server, runtime } = await createPreviewServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(origin);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Prueba local/);
    assert.match(html, /<form id="withdrawal-form">/);
    const payload = { name: 'Ana', item: 'Dos guantes', requestId: 'http-test-request-0001' };
    const send = data => fetch(origin + '/api/withdrawals', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    });
    const first = await send(payload);
    assert.equal(first.status, 200);
    assert.equal((await first.json()).duplicate, false);
    const retry = await send(payload);
    assert.equal((await retry.json()).duplicate, true);
    assert.equal(runtime.rows.length, 2);
    assert.equal(runtime.rows[1][0], 'Ana');
    const bad = await send({ ...payload, name: '' });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).message, /Completa/);
    assert.equal(runtime.rows.length, 2);
    assert.equal((await fetch(origin + '/missing')).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
