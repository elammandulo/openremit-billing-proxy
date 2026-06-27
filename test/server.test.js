const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCallbackRedirectUrl } = require('../src/server');

test('buildCallbackRedirectUrl preserves the UI base URL and adds consent params', () => {
  const result = buildCallbackRedirectUrl('http://localhost:3344/', {
    consent: 'ok',
    runId: 'abc123'
  });

  assert.equal(result, 'http://localhost:3344/?consent=ok&runId=abc123');
});
