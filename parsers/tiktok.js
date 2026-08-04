'use strict';

// TikTok Shop 结算单解析器。
// 期望列：
//   order_id, settlement_time, currency, order_amount,
//   commission_fee, logistics_fee, warehousing_fee, affiliate_fee,
//   refund_amount, adjustment_amount, settlement_amount

const { createParser } = require('../lib/settlement-parser');

module.exports = createParser({
  platform: 'tiktok',
  orderIdCol: 'order_id',
  currencyCol: 'currency',
  grossCol: 'order_amount',
  netCol: 'settlement_amount',
  dateCol: 'settlement_time',
  feeColumns: [
    'commission_fee',
    'logistics_fee',
    'warehousing_fee',
    'affiliate_fee',
    'refund_amount',
    'adjustment_amount',
  ],
});
