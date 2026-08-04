'use strict';

// Amazon Settlement 报表解析器。
// 假定输入是「每行一个订单」的结算汇总 CSV（真实 Amazon 报表是逐笔费用明细，
// 接入前需要先按 order-id 聚合成本文件这种宽表——这一步留给用户/上游脚本）。
//
// 期望列：
//   order_id, settled_at, currency, gross_sales,
//   commission_fee, fba_fee, storage_fee, advertising_fee,
//   refund_amount, other_adjustment, net_proceeds

const { createParser } = require('../lib/settlement-parser');

module.exports = createParser({
  platform: 'amazon',
  orderIdCol: 'order_id',
  currencyCol: 'currency',
  grossCol: 'gross_sales',
  netCol: 'net_proceeds', // 直接取报表给的净额，不自己用 gross-fees 推算
  dateCol: 'settled_at',
  feeColumns: [
    'commission_fee',
    'fba_fee',
    'storage_fee',
    'advertising_fee',
    'refund_amount',
    'other_adjustment',
  ],
});
