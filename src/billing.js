const crypto = require('crypto');
const http = require('http');
const { createAuthenticatedClient, createUnauthenticatedClient, isPendingGrant } = require('@interledger/open-payments');

class BillingEngine {
  constructor(config, updateCallback) {
    this.config = config; 
    this.updateCallback = updateCallback;
    
    this.totalBytes = 0;
    this.ratePerMB = 0.10;
    this.status = 'idle'; // 'idle', 'setup', 'awaiting_consent', 'online', 'limit_reached'
    this.lastDebitedCost = 0;
    this.authorizedGrantToken = null;
    this.client = null;
    this.sendingWallet = null;
    this.receivingWallet = null;
    
    // Budget & session tracking state
    this.sessionActive = false;
    this.maxBudget = 0.00; 

    this.settlementIntervalId = null;
  }

  // Called explicitly when the user submits their target budget from the UI front-end
  async startBillingSession(allowedBudget) {
    this.maxBudget = parseFloat(allowedBudget);
    this.status = 'setup';
    this.totalBytes = 0;
    this.lastDebitedCost = 0;
    this.sessionActive = false; // Stay false until authentication is fully approved

    try {
      this.triggerUpdate("[SYSTEM] Connecting to Interledger Network Pointers...");
      
      const unauthClient = await createUnauthenticatedClient({});
      this.sendingWallet = await unauthClient.walletAddress.get({ url: this.config.sendingWalletAddressUrl });
      this.receivingWallet = await unauthClient.walletAddress.get({ url: this.config.receivingWalletAddressUrl });

      this.client = await createAuthenticatedClient({
        walletAddressUrl: this.config.clientWalletAddressUrl,
        keyId: this.config.keyId,
        privateKey: this.config.privateKeyPath 
      });
      
      await this.requestOutgoingGrant();
    } catch (err) {
      this.status = 'idle';
      this.triggerUpdate(`[ERROR] Initialization Failed: ${err.message}`);
    }
  }

  async requestOutgoingGrant() {
    try {
      this.status = 'awaiting_consent';
      const callbackUrl = this.config.callbackUrl || `http://localhost:${this.config.callbackPort || 3344}/callback`;

      this.triggerUpdate(`[SYSTEM] Requesting Outgoing Grant matching your $${this.maxBudget.toFixed(2)} cap limit...`);

      // Scale the budget to integer units based on the sending wallet's asset scale configuration
      const scaledAmountValue = Math.round(this.maxBudget * Math.pow(10, this.sendingWallet.assetScale)).toString();

      const outgoingPaymentGrant = await this.client.grant.request(
        { url: this.sendingWallet.authServer },
        {
          access_token: {
            access: [
              {
                type: 'outgoing-payment',
                actions: ['read', 'create'],
                limits: {
                  debitAmount: {
                    assetCode: this.sendingWallet.assetCode,
                    assetScale: this.sendingWallet.assetScale,
                    value: scaledAmountValue
                  }
                },
                identifier: this.sendingWallet.id
              }
            ]
          },
          interact: {
            start: ['redirect'],
            finish: {
              method: 'redirect',
              uri: callbackUrl,
              nonce: crypto.randomUUID()
            }
          }
        }
      );

      if (isPendingGrant(outgoingPaymentGrant) && outgoingPaymentGrant.interact?.redirect) {
        this.continueUri = outgoingPaymentGrant.continue.uri;
        this.continueToken = outgoingPaymentGrant.continue.access_token.value;
        this.pendingGrant = outgoingPaymentGrant;
        
        this.triggerUpdate(`[REDIRECT] Authorization Link Generated successfully.`, {
          redirectUrl: outgoingPaymentGrant.interact.redirect
        });

        const interactRef = await waitForInteractRef(
          callbackUrl,
          this.config.callbackPort || 3999,
          this.config.uiBaseUrl || 'http://localhost:3344/'
        );
        return this.handleConsentCallback(interactRef);
      } else {
        throw new Error("Failed to receive interactive grant redirection target.");
      }
    } catch (err) {
      this.triggerUpdate(`[ERROR] Grant Request Failure: ${err.message}`);
      return false;
    }
  }

  async handleConsentCallback(interactRef) {
    try {
      if (!this.client || !this.continueUri || !this.continueToken) {
        throw new Error('Grant continuation data is missing. The consent flow was not initialized correctly.');
      }

      this.triggerUpdate("[SYSTEM] Verification received. Fetching live access tokens...");
      
      const finalizedGrant = await this.client.grant.continue(
        { url: this.continueUri, accessToken: this.continueToken },
        { interact_ref: interactRef }
      );

      if (finalizedGrant.access_token && finalizedGrant.access_token.value) {
        this.authorizedGrantToken = finalizedGrant.access_token.value;
        
        // AUTH COMPLETE: Open proxy stream gates
        this.status = 'online';
        this.sessionActive = true; 
        
        this.triggerUpdate("[SUCCESS] Proxy data processing session started! Metrics calculation engine active.");
        await this.settleUsage();
        this.startSettlementLoop();
        return true;
      }

      throw new Error('The grant did not return an access token after consent.');
    } catch (err) {
      this.status = 'idle';
      this.sessionActive = false;
      this.triggerUpdate(`[ERROR] Token extraction failed: ${err.message}`);
      return false;
    }
  }

  addBytes(bytes) {
    // BLOCKED: If session isn't online, drop data packages without counting them
    if (!this.sessionActive || this.status !== 'online') return;

    this.totalBytes += bytes;

    // Boundary check: Check if current accrued fees pass user cap limit boundaries
    const currentMetrics = this.getMetrics();
    const currentCost = parseFloat(currentMetrics.totalCost);
    if (this.maxBudget > 0 && currentCost >= this.maxBudget) {
      this.status = 'limit_reached';
      this.sessionActive = false; // Freeze metric pipeline aggregation completely
      if (this.settlementIntervalId) clearInterval(this.settlementIntervalId);
      void this.settleUsage();
      this.triggerUpdate(`[⚠️ BUDGET LIMIT REACHED] The $${this.maxBudget.toFixed(2)} cap was spent. Data counting stopped. Set a new budget to continue.`);
      return;
    }

    this.triggerUpdate(); 
  }

  getMetrics() {
    const totalMB = this.totalBytes / (1024 * 1024);
    const totalCost = totalMB * this.ratePerMB;
    return {
      totalBytes: this.totalBytes,
      totalMB: totalMB.toFixed(4),
      totalCost: totalCost.toFixed(4),
      status: this.status,
      maxBudget: this.maxBudget.toFixed(2),
      userWallet: this.config.sendingWalletAddressUrl,
      ispWallet: this.config.receivingWalletAddressUrl
    };
  }

  triggerUpdate(logMessage, extra = {}) {
    if (this.updateCallback) {
      this.updateCallback({
        metrics: this.getMetrics(),
        log: logMessage,
        ...extra
      });
    }
  }

  async settleUsage() {
    if (!this.client || !this.sendingWallet || !this.receivingWallet) {
      return;
    }

    if (this.status === 'limit_reached') {
      return;
    }

    const metrics = this.getMetrics();
    const currentCost = parseFloat(metrics.totalCost);

    if (currentCost <= 0) {
      return;
    }

    if (this.maxBudget > 0 && currentCost < this.maxBudget && this.status !== 'limit_reached') {
      return;
    }

    const unpaidDelta = currentCost - this.lastDebitedCost;
    if (unpaidDelta < 0.01 && this.lastDebitedCost > 0) {
      return;
    }

    try {
      this.lastDebitedCost = currentCost;
      const incomingAmountValue = Math.max(1, Math.round(currentCost * Math.pow(10, this.receivingWallet.assetScale))).toString();

      if (!this.authorizedGrantToken) {
        await this.refreshAuthorizedGrant();
      }

      const incomingPaymentGrant = await this.client.grant.request(
        { url: this.receivingWallet.authServer },
        { access_token: { access: [{ type: 'incoming-payment', actions: ['read', 'complete', 'create'] }] } }
      );

      const incomingPayment = await this.client.incomingPayment.create(
        { url: this.receivingWallet.resourceServer, accessToken: incomingPaymentGrant.access_token.value },
        {
          walletAddress: this.receivingWallet.id,
          incomingAmount: {
            assetCode: this.receivingWallet.assetCode,
            assetScale: this.receivingWallet.assetScale,
            value: incomingAmountValue
          },
          metadata: { description: `Data Proxy usage invoice for ${metrics.totalMB} MB` }
        }
      );

      const quoteGrant = await this.client.grant.request(
        { url: this.sendingWallet.authServer },
        { access_token: { access: [{ type: 'quote', actions: ['create', 'read'] }] } }
      );

      const quote = await this.client.quote.create(
        { url: this.sendingWallet.resourceServer, accessToken: quoteGrant.access_token.value },
        { walletAddress: this.sendingWallet.id, receiver: incomingPayment.id, method: 'ilp' }
      );

      await this.client.outgoingPayment.create(
        { url: this.sendingWallet.resourceServer, accessToken: this.authorizedGrantToken },
        { walletAddress: this.sendingWallet.id, quoteId: quote.id }
      );

      this.triggerUpdate(`[INTERLEDGER SETTLED] Cleared $${Math.max(unpaidDelta, 0.01).toFixed(4)} sequentially to ISP.`);
    } catch (billingErr) {
      const message = billingErr?.message || String(billingErr);
      const status = billingErr?.status || billingErr?.response?.status;
      const body = billingErr?.response?.body || billingErr?.body || billingErr?.response?.data;
      const detail = [message, status ? `status=${status}` : '', body ? `body=${JSON.stringify(body)}` : ''].filter(Boolean).join(' | ');

      if (status === 403 && this.client) {
        try {
          await this.refreshAuthorizedGrant();
          await this.settleUsage();
          return;
        } catch (refreshErr) {
          this.triggerUpdate(`[SETTLE SUSPENDED] Background billing pause. Reason: ${detail}`);
          return;
        }
      }

      this.triggerUpdate(`[SETTLE SUSPENDED] Background billing pause. Reason: ${detail}`);
    }
  }

  async refreshAuthorizedGrant() {
    if (!this.client || !this.sendingWallet) {
      throw new Error('Billing client or sending wallet is not ready.');
    }

    const scaledAmountValue = Math.round(this.maxBudget * Math.pow(10, this.sendingWallet.assetScale)).toString();
    const refreshedGrant = await this.client.grant.request(
      { url: this.sendingWallet.authServer },
      {
        access_token: {
          access: [
            {
              type: 'outgoing-payment',
              actions: ['read', 'create'],
              limits: {
                debitAmount: {
                  assetCode: this.sendingWallet.assetCode,
                  assetScale: this.sendingWallet.assetScale,
                  value: scaledAmountValue
                }
              },
              identifier: this.sendingWallet.id
            }
          ]
        },
        interact: {
          start: ['redirect'],
          finish: {
            method: 'redirect',
            uri: this.config.callbackUrl || `http://localhost:${this.config.callbackPort || 3999}/callback`,
            nonce: crypto.randomUUID()
          }
        }
      }
    );

    if (!isPendingGrant(refreshedGrant) || !refreshedGrant.continue?.access_token?.value) {
      throw new Error('Unable to refresh outgoing-payment grant.');
    }

    this.continueUri = refreshedGrant.continue.uri;
    this.continueToken = refreshedGrant.continue.access_token.value;
    this.pendingGrant = refreshedGrant;
    this.authorizedGrantToken = null;
    throw new Error('Refresh required; the outgoing-payment grant must be continued again.');
  }

  startSettlementLoop() {
    if (this.settlementIntervalId) clearInterval(this.settlementIntervalId);
    this.settlementIntervalId = null;
  }
}

function waitForInteractRef(callbackUrl, port, uiBaseUrl) {
  return new Promise((resolve, reject) => {
    let server;
    let settled = false;
    let timer;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (server) server.close();
    };

    const settle = (fn) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    timer = setTimeout(() => {
      settle(() => reject(new Error('Consent timed out waiting for callback.')));
    }, 180000);

    server = http.createServer((req, res) => {
      const parsedUrl = new URL(req.url || '/', callbackUrl);
      const interactRef = parsedUrl.searchParams.get('interact_ref');

      if (parsedUrl.pathname !== '/callback' && parsedUrl.pathname !== '/') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }

      if (!interactRef) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing interact_ref');
        settle(() => reject(new Error('Missing interact_ref')));
        return;
      }

      res.writeHead(302, { Location: uiBaseUrl });
      res.end();
      settle(() => resolve(interactRef));
    });

    server.on('error', (err) => {
      settle(() => reject(err));
    });

    server.listen(port, '127.0.0.1');
  });
}

module.exports = BillingEngine;
module.exports.waitForInteractRef = waitForInteractRef;