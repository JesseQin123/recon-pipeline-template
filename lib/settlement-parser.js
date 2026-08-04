'use strict';

// 三个内置平台（amazon/shopify/tiktok）的报表结构其实是同一种模式：
// 「每行一个订单的结算汇总，若干费用列 + 一个权威净额列」。
// 这个工厂把这套通用逻辑抽出来，平台 parser 只需要声明自己的列名。
//
// 如果你的新平台报表不是这种简单形状（比如净额需要自己推算、或者是逐笔费用明细
// 而不是按订单聚合），不要用这个工厂——照着 parsers/_template.js 手写 parse()。

const { parseCSV } = require('./csv');

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * @param {object} spec
 * @param {string} spec.platform
 * @param {string} spec.orderIdCol
 * @param {string} spec.currencyCol
 * @param {string} spec.grossCol
 * @param {string} spec.netCol      报表自带的权威净额列，不用 gross-fees 重新计算
 * @param {string} spec.dateCol
 * @param {string[]} spec.feeColumns 会被计入费用、参与科目翻译的原始列名
 * @returns {{platform: string, parse: (csvText: string, categories: object) => object[]}}
 */
function createParser(spec) {
  return {
    platform: spec.platform,
    parse(csvText, categories) {
      const map = (categories && categories[spec.platform]) || {};
      const fallback = (categories && categories._default) || '其他';

      return parseCSV(csvText).map((row) => {
        const fee_breakdown = {};
        let fees = 0;
        for (const col of spec.feeColumns) {
          const amount = num(row[col]);
          if (amount === 0) continue;
          fees += amount;
          const category = map[col] || fallback;
          fee_breakdown[category] = round2((fee_breakdown[category] || 0) + amount);
        }
        return {
          platform: spec.platform,
          order_id: row[spec.orderIdCol],
          currency: (row[spec.currencyCol] || '').toUpperCase(),
          gross: num(row[spec.grossCol]),
          fees: round2(fees),
          net: num(row[spec.netCol]),
          settled_at: row[spec.dateCol],
          fee_breakdown,
        };
      });
    },
  };
}

module.exports = { createParser, num, round2 };
