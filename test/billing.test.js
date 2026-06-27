const test = require('node:test');
const assert = require('node:assert/strict');
const BillingEngine = require('../src/billing');
const { waitForInteractRef } = require('../src/billing');

test('handleConsentCallback returns false when continuation data is missing', async () => {
  const engine = new BillingEngine(
    {
      clientWalletAddressUrl: 'https://example.com/client',
      sendingWalletAddressUrl: 'https://example.com/sender',
      receivingWalletAddressUrl: 'https://example.com/receiver',
      keyId: 'test-key',
      privateKeyPath: './private.key',
      callbackUrl: 'http://localhost:3344/callback'
    },
    () => {}
  );

  const result = await engine.handleConsentCallback('test-interact-ref');
  assert.equal(result, false);
});

test('settleUsage includes incomingAmount when creating the incoming payment', async () => {
  const engine = new BillingEngine(
    {
      clientWalletAddressUrl: 'https://example.com/client',
      sendingWalletAddressUrl: 'https://example.com/sender',
      receivingWalletAddressUrl: 'https://example.com/receiver',
      keyId: 'test-key',
      privateKeyPath: './private.key',
      callbackUrl: 'http://localhost:3344/callback'
    },
    () => {}
  );

  const payloads = [];
  engine.client = {
    grant: {
      request: async (_url, body) => {
        if (body.access_token.access[0].type === 'incoming-payment') {
          return { access_token: { value: 'incoming-grant' } };
        }
        return { access_token: { value: 'quote-grant' } };
      }
    },
    incomingPayment: {
      create: async (_resource, body) => {
        payloads.push(body);
        return { id: 'incoming-payment-id' };
      }
    },
    quote: {
      create: async () => ({ id: 'quote-id' })
    },
    outgoingPayment: {
      create: async () => ({ id: 'payment-id' })
    }
  };

  engine.sendingWallet = { authServer: 'https://sending.auth', id: 'sending-id', assetCode: 'USD', assetScale: 2 };
  engine.receivingWallet = { authServer: 'https://receiving.auth', resourceServer: 'https://receiving.resource', id: 'receiving-id', assetCode: 'USD', assetScale: 2 };
  engine.authorizedGrantToken = 'authorized-token';
  engine.totalBytes = 1024 * 1024;

  await engine.settleUsage();

  assert.equal(payloads[0].incomingAmount.value, '10');
  assert.equal(payloads[0].incomingAmount.assetScale, 2);
});
