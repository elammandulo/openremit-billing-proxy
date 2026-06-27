// Load environment variables right at the entry point
require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { createProxyServer } = require('./proxy');
const BillingEngine = require('./billing');

// Map network ports and URLs from environment variables with safe defaults
const APP_PORT = Number(process.env.APP_PORT || 3344);
const PROXY_PORT = Number(process.env.PROXY_PORT || 8080);
const CALLBACK_PORT = Number(process.env.CALLBACK_PORT || 3999);
const CALLBACK_URL = process.env.CALLBACK_URL || `http://localhost:${CALLBACK_PORT}/callback`;
const UI_BASE_URL = process.env.UI_BASE_URL || `http://localhost:${APP_PORT}/`;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// --- MIDDLEWARE CONFIGURATION ---
app.use(express.json());

// --- CONFIGURE INTERLEDGER WALLET PARAMETERS HERE ---
function normalizeWalletAddressUrl(raw) {
  if (!raw) return '';
  const v = raw.trim();
  if (!v) return '';
  if (v.startsWith('$')) return `https://${v.slice(1)}`;
  return v;
}

// Cleanly mapped directly from your .env variables
const opConfig = {
  clientWalletAddressUrl: normalizeWalletAddressUrl(process.env.CLIENT_WALLET_ADDRESS_URL || ''), 
  sendingWalletAddressUrl: normalizeWalletAddressUrl(process.env.SENDING_WALLET_ADDRESS_URL || ''), 
  receivingWalletAddressUrl: normalizeWalletAddressUrl(process.env.RECEIVING_WALLET_ADDRESS_URL || ''),
  keyId: process.env.KEY_ID || '',
  privateKeyPath: process.env.PRIVATE_KEY_PATH || '', 
  callbackPort: CALLBACK_PORT,
  callbackUrl: CALLBACK_URL
};

function buildCallbackRedirectUrl(baseUrl, params = {}) {
  const url = new URL(baseUrl);

  Object.entries(params).forEach(([key, value]) => {
    if (typeof value === 'string' && value.trim()) {
      url.searchParams.set(key, value);
    }
  });

  return url.toString();
}

// --- ROUTING PATHS ---

// 1. Serve the dashboard view
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// 2. Receives the user-defined budget from the UI
app.post('/api/start-session', async (req, res) => {
  const { budget } = req.body;
  
  if (!budget || isNaN(budget) || parseFloat(budget) <= 0) {
    return res.status(400).json({ error: "Please enter a valid allocation budget value above $0.00" });
  }

  try {
    await billing.startBillingSession(budget);
    res.json({ success: true });
  } catch (err) {
    console.error('Start session failed:', err);
    res.status(500).json({ error: err.message || 'Unable to start the authorization flow.' });
  }
});

// 3. Interactive Grant Callback Handler
app.get('/callback', async (req, res) => {
  const interactRef = req.query.interact_ref;
  if (typeof interactRef !== 'string' || !interactRef) {
    return res.status(400).send('Authorization missing interaction reference metadata.');
  }

  try {
    const success = await billing.handleConsentCallback(interactRef);
    if (success) {
      const redirectTarget = buildCallbackRedirectUrl(UI_BASE_URL, {
        consent: 'ok',
        runId: typeof req.query.runId === 'string' ? req.query.runId : undefined
      });

      return res.redirect(302, redirectTarget);
    }

    return res.status(500).send('Authorization completed, but the billing session could not be finalized. Check the server logs for details.');
  } catch (err) {
    console.error('Consent callback failed:', err);
    return res.status(500).send(`Authorization callback failed: ${err.message}`);
  }
});

// --- CORE SYSTEM INITIALIZATION ---

const billing = new BillingEngine(opConfig, (updatePayload) => {
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(JSON.stringify(updatePayload));
  });
});

const proxyServer = createProxyServer((event) => {
  if (event.bytes > 0) billing.addBytes(event.bytes);
});

if (require.main === module) {
  server.listen(APP_PORT, () => {
    console.log(`🚀 DASHBOARD & CONSENT SERVER ACTIVE: http://localhost:${APP_PORT}`);
  });

  proxyServer.listen(PROXY_PORT, () => {
    console.log(`⚡ PROXY INTERCEPTOR METRIC SENSOR RUNNING ON PORT: ${PROXY_PORT}`);
  });
}

module.exports = {
  app,
  billing,
  buildCallbackRedirectUrl,
  normalizeWalletAddressUrl,
  opConfig
};