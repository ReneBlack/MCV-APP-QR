import test from 'node:test';
import assert from 'node:assert/strict';
import { printableQr } from '../tools/create-qr.mjs';

test('creates a printable QR with quiet zone and the exact public deployment URL', () => {
  const url = 'https://script.google.com/macros/s/test-deployment-id/exec';
  const result = printableQr(url);
  assert.match(result, /<svg/);
  assert.match(result, /viewBox=/);
  assert.match(result, /window.print\(\)/);
  assert.ok(result.includes(url));
  assert.match(result, /Escanea este QR/);
});

test('rejects development, insecure, unrelated and decorated URLs before printing', () => {
  for (const input of [undefined, '', 'http://script.google.com/macros/s/id/exec',
    'https://script.google.com/macros/s/id/dev', 'https://example.com/',
    'https://script.google.com/macros/s/id/exec?x=1',
    'https://script.google.com/macros/s/id/exec#x',
    'https://user:password@script.google.com/macros/s/id/exec']) {
    assert.throws(() => printableQr(input));
  }
});
