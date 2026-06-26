const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { createProxyServer } = require('./proxy');
const BillingEngine = require('./billing');

const APP_PORT = 3344;
const PROXY_PORT = 8080;
const CALLBACK_PORT = 3999;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// --- CONFIGURE INTERLEDGER WALLET PARAMETERS HERE ---
// A quick helper function to convert payment pointers (add this near the top of server.js)
function normalizeWalletAddressUrl(raw) {
  const v = raw.trim();
  if (!v) return '';
  if (v.startsWith('$')) return `https://${v.slice(1)}`;
  return v;
}

// Update your opConfig object to match this structure exactly:
const opConfig = {
  clientWalletAddressUrl: normalizeWalletAddressUrl('$ilp.interledger-test.dev/usd_account'), 
  sendingWalletAddressUrl: normalizeWalletAddressUrl('$ilp.interledger-test.dev/usd_account'), 
  receivingWalletAddressUrl: normalizeWalletAddressUrl('$ilp.interledger-test.dev/f44c621'),
  keyId: 'e0b1b1d6-ed21-4b55-92db-ff682fa94e94',
  
  // FIXED PATH: Uses double backslashes so Windows parses the string correctly
  privateKeyPath: 'C:\\Users\\elamm\\openremit-billing-proxy\\private.key', 
  
  callbackPort: CALLBACK_PORT
};

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

const billing = new BillingEngine(opConfig, (updatePayload) => {
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(JSON.stringify(updatePayload));
  });
});

// Interactive Grant Callback Handler
app.get('/callback', (req, res) => {
  const interactRef = req.query.interact_ref;
  if (interactRef) {
    billing.handleConsentCallback(interactRef);
    res.send("<h1>Authorization Received! Redirecting...</h1><script>setTimeout(() => window.location.href='http://localhost:3344', 1500);</script>");
  } else {
    res.status(400).send("Authorization missing interaction reference metadata.");
  }
});

const proxyServer = createProxyServer((event) => {
  if (event.bytes > 0) billing.addBytes(event.bytes);
});

server.listen(APP_PORT, () => {
  console.log(`🚀 DASHBOARD & CONSENT SERVER ACTIVE: http://localhost:${APP_PORT}`);
});

proxyServer.listen(PROXY_PORT, () => {
  console.log(`⚡ PROXY INTERCEPTOR METRIC SENSOR RUNNING ON PORT: ${PROXY_PORT}`);
});