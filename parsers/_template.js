'use strict';

// ============================================================================
// 新平台适配器模板
//
// 接入一个新平台只需要三步：
//   1. 复制本文件为 parsers/<平台名>.js（平台名用小写英文，如 lazada.js）
//   2. 把下面 platform 字段改成同样的平台名，实现 parse()
//   3. 在 reconcile.js 顶部的 PARSER_BY_PREFIX 里加一行映射
//      （文件名前缀 -> 你的模块），例如样例报表文件名为 lazada-xxx.csv
//
// 不需要改动 reconcile.js 的匹配/汇总逻辑——那部分只认统一记录格式。
//
// 提示：如果你的新平台报表形状和 amazon/shopify/tiktok 一样简单——「每行一个订单，
// 若干费用列 + 一个报表自带的权威净额列」——可以直接用 lib/settlement-parser.js 的
// createParser({...}) 工厂，几行配置就够了，参考 parsers/amazon.js。
// 下面这份手写版本适合形状不一样的报表（比如净额需要自己算、或者是逐笔费用明细）。
// ============================================================================

const { parseCSV } = require('../lib/csv');

// 第一步：把该平台结算报表里代表"费用/扣款"的原始列名列在这里。
// 这些列名要和 mappings/categories.json 里 <platform> 小节的 key 一一对应，
// 否则会退回 categories._default（通常是"其他"）。
const FEE_COLUMNS = [
  // 'commission_fee',
  // 'logistics_fee',
  // ...
];

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * @param {string} csvText 原始报表文件内容
 * @param {object} categories mappings/categories.json 的完整内容（含所有平台 + _default）
 * @returns {object[]} 必须返回统一记录数组，每条形如：
 *   {
 *     platform: '<你的平台名>',
 *     order_id: string,          // 订单号，用于人工核对/白名单匹配
 *     currency: 'USD' | 'EUR' | ...,
 *     gross: number,             // 订单原始金额（未扣费）
 *     fees: number,              // 费用合计（正数，代表被扣掉的金额）
 *     net: number,               // 平台实际结算/到账金额，直接取报表里的字段，
 *                                // 不要自己用 gross-fees 重新计算——报表给的净额才是权威值
 *     settled_at: 'YYYY-MM-DD',  // 结算日期，用于按 ±3 天窗口匹配银行流水
 *     fee_breakdown: { 佣金: 12.3, 物流: 4.5, ... }, // 按 categories.json 翻译后的科目明细
 *   }
 */
function parse(csvText, categories) {
  const platform = 'your-platform-id'; // TODO: 改成真实平台名
  const map = (categories && categories[platform]) || {};
  const fallback = (categories && categories._default) || '其他';

  return parseCSV(csvText).map((row) => {
    const fee_breakdown = {};
    let fees = 0;
    for (const col of FEE_COLUMNS) {
      const amount = num(row[col]);
      if (amount === 0) continue;
      fees += amount;
      const category = map[col] || fallback;
      fee_breakdown[category] = round2((fee_breakdown[category] || 0) + amount);
    }
    return {
      platform,
      order_id: row.order_id, // TODO: 换成该平台报表里真实的订单号列名
      currency: (row.currency || '').toUpperCase(), // TODO: 换成真实列名
      gross: num(row.gross_amount), // TODO
      fees: round2(fees),
      net: num(row.net_amount), // TODO：一定用报表自带的净额列，不要自己推算
      settled_at: row.settled_at, // TODO
      fee_breakdown,
    };
  });
}

module.exports = { platform: 'your-platform-id', parse };
