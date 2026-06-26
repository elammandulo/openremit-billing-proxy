const crypto = require('crypto');
const { createAuthenticatedClient, createUnauthenticatedClient, isPendingGrant } = require('@interledger/open-payments');

class BillingEngine {
  constructor(config, updateCallback) {
    this.config = config; 
    this.updateCallback = updateCallback;
    
    this.totalBytes = 0;
    this.ratePerMB = 0.10;
    this.status = 'setup'; 
    this.lastDebitedCost = 0;
    this.authorizedGrantToken = null;
    this.client = null;
    this.sendingWallet = null;
    this.receivingWallet = null;

    this.initializeOpenPayments();
  }

  async initializeOpenPayments() {
    try {
      this.triggerUpdate("[SYSTEM] Resolving wallet pointer records via Unauthenticated Client...");
      
      // 1. Use an unauthenticated client to safely look up public wallet details (like the template does)
      const unauthClient = await createUnauthenticatedClient({});
      
      this.sendingWallet = await unauthClient.walletAddress.get({ url: this.config.sendingWalletAddressUrl });
      this.receivingWallet = await unauthClient.walletAddress.get({ url: this.config.receivingWalletAddressUrl });

      this.triggerUpdate(`[SYSTEM] Resolved Pointers. Asset Scale: ${this.sendingWallet.assetScale}, Code: ${this.sendingWallet.assetCode}`);

      // 2. Instantiate Authenticated Client only for signing your own Outgoing payment actions
      this.client = await createAuthenticatedClient({
        walletAddressUrl: this.config.clientWalletAddressUrl,
        keyId: this.config.keyId,
        privateKey: this.config.privateKeyPath 
      });
      
      // 3. Request Outgoing Payment Grant with User Interaction
      await this.requestOutgoingGrant();

    } catch (err) {
      this.status = 'offline';
      this.triggerUpdate(`[ERROR] Open Payments Initialization Failed: ${err.message}`);
    }
  }

  async requestOutgoingGrant() {
    try {
      this.status = 'awaiting_consent';
      const callbackUrl = `http://localhost:${this.config.callbackPort || 3999}/callback`;

      this.triggerUpdate("[SYSTEM] Requesting Multi-Payment Outgoing Authorization Grant...");

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
                    value: "500" 
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
        
        this.triggerUpdate(`[INTERACTION REQUIRED] Please authorize proxy settlement link.`, {
          redirectUrl: outgoingPaymentGrant.interact.redirect
        });
      } else {
        throw new Error("Failed to receive interactive grant redirection target.");
      }
    } catch (err) {
      this.triggerUpdate(`[ERROR] Grant Request Failure: ${err.message}`);
    }
  }

  async handleConsentCallback(interactRef) {
    try {
      this.triggerUpdate("[SYSTEM] Consent received. Confirming continuation token details...");
      
      const finalizedGrant = await this.client.grant.continue(
        {
          url: this.continueUri,
          accessToken: this.continueToken
        },
        { interact_ref: interactRef }
      );

      if (finalizedGrant.access_token && finalizedGrant.access_token.value) {
        this.authorizedGrantToken = finalizedGrant.access_token.value;
        this.status = 'online';
        this.triggerUpdate("[SUCCESS] Open Payments Setup Complete! Internet usage data streams are now authorized.");
        this.startSettlementLoop();
      }
    } catch (err) {
      this.triggerUpdate(`[ERROR] Continuation processing failed: ${err.message}`);
    }
  }

  addBytes(bytes) {
    this.totalBytes += bytes;
    this.triggerUpdate(); 
  }

  // --- FIX: Map the wallet data values explicitly down to the front end metrics payload ---
  getMetrics() {
    const totalMB = this.totalBytes / (1024 * 1024);
    const totalCost = totalMB * this.ratePerMB;
    return {
      totalBytes: this.totalBytes,
      totalMB: totalMB.toFixed(4),
      totalCost: totalCost.toFixed(4),
      status: this.status,
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

  startSettlementLoop() {
    setInterval(async () => {
      if (this.status !== 'online') return;

      const metrics = this.getMetrics();
      const currentCost = parseFloat(metrics.totalCost);
      const unpaidDelta = currentCost - this.lastDebitedCost;

      if (unpaidDelta >= 0.01) {
        try {
          this.lastDebitedCost = currentCost;
          
          const incomingPaymentGrant = await this.client.grant.request(
            { url: this.receivingWallet.authServer },
            { access_token: { access: [{ type: 'incoming-payment', actions: ['read', 'complete', 'create'] }] } }
          );

          const incomingPayment = await this.client.incomingPayment.create(
            { url: this.receivingWallet.resourceServer, accessToken: incomingPaymentGrant.access_token.value },
            {
              walletAddress: this.receivingWallet.id,
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

          const payment = await this.client.outgoingPayment.create(
            { url: this.sendingWallet.resourceServer, accessToken: this.authorizedGrantToken },
            { walletAddress: this.sendingWallet.id, quoteId: quote.id }
          );

          this.triggerUpdate(`[INTERLEDGER CLEARANCE] Transferred $${unpaidDelta.toFixed(4)} sequentially to ISP. Payment ID: ${payment.id}`);
        } catch (billingErr) {
          this.triggerUpdate(`[SETTLE SUSPENDED] Background billing pause. Reason: ${billingErr.message}`);
        }
      }
    }, 3000);
  }
}

module.exports = BillingEngine;