import test from 'node:test';
import assert from 'node:assert/strict';
import * as runtime from '../js/runtime/business-features.js';
import * as accuracy from '../js/accuracy.js';
import * as estimates from '../js/eastmoney-estimate.js';
import * as holdings from '../js/fund-holdings.js';
import * as lookthrough from '../js/holdings-estimate.js';
import * as models from '../js/runtime/fund-model-enrichment.js';
import * as bridge from '../js/runtime/quote-bridge-client.js';
import * as notifications from '../js/notifications/notification-controller.js';
import * as edit from '../js/runtime/holding-edit.js';
import * as transfer from '../js/runtime/holdings-transfer.js';
import * as refresh from '../js/runtime/refresh-execution.js';
import * as security from '../js/runtime/security-quote-batch.js';

test('lazy business surface is exactly the live runtime API, preserving original function identities', () => {
  const names = {
    updateFundAccuracy: accuracy, fetchEstimateRows: estimates,
    fetchFundHoldings: holdings, holdingQuoteCode: holdings,
    calculateHoldingsEstimate: lookthrough, composeFundEnrichment: lookthrough, normalizeTencentQuoteTime: lookthrough,
    applyOverseasModelEstimate: models, getOverseasConfig: models, loadOverseasModels: models, selectOverseasModel: models,
    createQuoteBridgeClient: bridge, createNotificationController: notifications,
    commitHoldingEdit: edit, createHoldingsTransfer: transfer, executeRefreshPlan: refresh,
    executeDetailSecurityQuotes: security, assessDetailSecurityQuote: security,
  };
  assert.deepEqual(Object.keys(runtime).sort(), Object.keys(names).sort());
  for (const [name, module] of Object.entries(names)) {
    assert.equal(typeof runtime[name], 'function', name);
    assert.equal(runtime[name], module[name], name);
  }
});
