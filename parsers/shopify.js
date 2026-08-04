'use strict';

// Shopify Payouts 报表解析器。
// 期望列：
//   order_id, payout_date, currency, gross_amount,
//   processing_fee, shipping_label_fee, ad_spend,
//   refund_amount, chargeback_adjustment, net_amount

const { createParser } = require('../lib/settlement-parser');

module.exports = createParser({
  platform: 'shopify',
  orderIdCol: 'order_id',
  currencyCol: 'currency',
  grossCol: 'gross_amount',
  netCol: 'net_amount',
  dateCol: 'payout_date',
  feeColumns: ['processing_fee', 'shipping_label_fee', 'ad_spend', 'refund_amount', 'chargeback_adjustment'],
});
