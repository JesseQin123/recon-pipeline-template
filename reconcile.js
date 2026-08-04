#!/usr/bin/env node
'use strict';

// 多平台对账流水线 —— 零依赖 Node.js 脚本。
// 用法：node reconcile.js --input <平台报表目录> --bank <银行流水.csv> --out <report.csv>
//
// 流程：
//   1. 按文件名前缀识别每个平台报表，用对应 parsers/*.js 解析成统一记录
//      {platform, order_id, currency, gross, fees, net, settled_at, fee_breakdown}
//   2. 解析银行流水（可选套用 mappings/bank.json 做表头映射）
//   3. 按「金额 + ±3 天日期窗口」把每条平台记录和一条银行流水配对
//      （同币种直接比金额；跨币种按 mappings/rates.json 静态汇率折算后比较）
//   4. 差异分四类输出：平台少结 / 银行未到 / 汇率损耗超阈值 / 来源不明入账
//      （来源不明入账 = 银行流水里没有被任何平台记录认领的行——绝不能因为只遍历
//      平台记录就把这类行漏掉，宁可报未匹配，绝不吞掉差异）
//   5. 写 report.csv，末尾附四类差异的汇总行

const fs = require('node:fs');
const path = require('node:path');
const { toCSV } = require('./lib/csv');

const PARSER_BY_PREFIX = [
  ['amazon', require('./parsers/amazon')],
  ['shopify', require('./parsers/shopify')],
  ['tiktok', require('./parsers/tiktok')],
];

const MATCH_WINDOW_DAYS = 3;
const PLAUSIBLE_CAP_PCT = 0.5; // 超过 50% 偏差的候选直接视为不可信，不参与匹配
const SAME_CURRENCY_TOLERANCE_PCT = 0.005; // 同币种 0.5% 内视为四舍五入误差，判定已匹配

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ONE_DAY_MS = MS_PER_DAY;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      args[a.slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

function readJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function detectPlatform(filename) {
  const lower = filename.toLowerCase();
  for (const [prefix, parser] of PARSER_BY_PREFIX) {
    if (lower.startsWith(prefix)) return parser;
  }
  return null;
}

// 读取全部平台报表 CSV，解析成统一记录数组
function loadPlatformRecords(inputDir, categories) {
  const files = fs
    .readdirSync(inputDir)
    .filter((f) => f.toLowerCase().endsWith('.csv'))
    .sort(); // 固定顺序，保证匹配结果可复现

  const records = [];
  for (const file of files) {
    const parser = detectPlatform(file);
    if (!parser) {
      console.error(`[警告] 无法识别报表文件所属平台，已跳过：${file}`);
      continue;
    }
    const text = fs.readFileSync(path.join(inputDir, file), 'utf8');
    records.push(...parser.parse(text, categories));
  }
  return records;
}

// 解析银行流水 CSV，支持通过 mappings/bank.json 把非标表头映射到统一字段名
function loadBankRecords(bankPath, bankMap) {
  const { parseCSV } = require('./lib/csv');
  const CANONICAL = new Set(['date', 'amount', 'currency', 'reference']);
  const text = fs.readFileSync(bankPath, 'utf8');
  const rawRows = parseCSV(text);

  return rawRows
    .map((row) => {
      const rec = {};
      for (const [key, value] of Object.entries(row)) {
        const canon = bankMap[key] || (CANONICAL.has(key) ? key : null);
        if (canon) rec[canon] = value;
      }
      return {
        date: rec.date,
        amount: num(rec.amount),
        currency: (rec.currency || '').toUpperCase(),
        reference: rec.reference || '',
        consumed: false,
      };
    })
    .filter((r) => r.date && r.currency);
}

// 把 amount（fromCcy）折算成 toCcy，基于 rates.json 的静态汇率表
function convert(amount, fromCcy, toCcy, rates) {
  if (fromCcy === toCcy) return amount;
  const rf = rates.rates[fromCcy];
  const rt = rates.rates[toCcy];
  if (!rf || !rt) return null; // 汇率表没有该币种，视为无法折算
  return (amount * rf) / rt;
}

function daysBetween(a, b) {
  return Math.abs((a.getTime() - b.getTime()) / ONE_DAY_MS);
}

// 核心匹配 + 差异分类
function reconcileRecords(records, bankRows, rates, whitelistKeys) {
  const lossThreshold = (rates.loss_threshold_pct || 3) / 100;
  const results = [];

  for (const rec of records) {
    const recDate = new Date(rec.settled_at);
    let best = null;
    let bestDiffPct = Infinity;
    let bestExpected = null;

    for (const b of bankRows) {
      if (b.consumed) continue;
      const bankDate = new Date(b.date);
      if (!isFinite(recDate.getTime()) || !isFinite(bankDate.getTime())) continue;
      if (daysBetween(recDate, bankDate) > MATCH_WINDOW_DAYS) continue;

      const expected = convert(rec.net, rec.currency, b.currency, rates);
      if (expected === null || expected <= 0) continue;

      const diffPct = Math.abs(b.amount - expected) / expected;
      if (diffPct > PLAUSIBLE_CAP_PCT) continue; // 偏差太离谱，不认为是同一笔

      if (diffPct < bestDiffPct) {
        bestDiffPct = diffPct;
        best = b;
        bestExpected = expected;
      }
    }

    let status;
    let note;

    if (!best) {
      status = '银行未到';
      note = `±${MATCH_WINDOW_DAYS}天窗口内无可信匹配的银行流水（预期 ${rec.net.toFixed(2)} ${rec.currency}）`;
    } else {
      const sameCcy = best.currency === rec.currency;
      const tolerance = sameCcy ? SAME_CURRENCY_TOLERANCE_PCT : lossThreshold;

      if (bestDiffPct <= tolerance) {
        status = '已匹配';
        note = sameCcy
          ? ''
          : `按静态汇率折算，预期 ${bestExpected.toFixed(2)} ${best.currency}，实际到账 ${best.amount.toFixed(2)} ${best.currency}，汇兑偏差 ${(bestDiffPct * 100).toFixed(1)}%（阈值内）`;
      } else if (best.amount < bestExpected) {
        // 到账金额低于预期
        if (sameCcy) {
          status = '平台少结';
          note = `平台报告净额 ${rec.net.toFixed(2)} ${rec.currency}，银行实际到账 ${best.amount.toFixed(2)} ${best.currency}，短缺 ${(bestExpected - best.amount).toFixed(2)}`;
        } else {
          status = '汇率损耗';
          note = `按静态汇率折算预期 ${bestExpected.toFixed(2)} ${best.currency}，实际到账 ${best.amount.toFixed(2)} ${best.currency}，汇兑损耗 ${(bestExpected - best.amount).toFixed(2)}（偏差 ${(bestDiffPct * 100).toFixed(1)}%，超过阈值 ${(lossThreshold * 100).toFixed(1)}%）`;
        }
      } else {
        // 到账金额高于预期——不属于三类既定差异，但不应被静默吞掉
        status = '已匹配';
        note = `银行到账金额高于预期（预期 ${bestExpected.toFixed(2)} ${best.currency}，实际 ${best.amount.toFixed(2)} ${best.currency}），建议人工复核`;
      }
      best.consumed = true;
    }

    // 白名单：已经和用户确认过、可以不用每周重复报的差异
    const whitelistKey = `${rec.platform}:${rec.order_id}`;
    const whitelisted = status !== '已匹配' && whitelistKeys.has(whitelistKey);
    if (whitelisted) {
      note = `[白名单已确认] ${note}`;
      status = '已匹配（白名单）';
    }

    results.push({
      rec,
      bank: best,
      status,
      note,
      countsInSummary: !whitelisted,
      shortfallAmount:
        best && best.amount < bestExpected ? round2(bestExpected - best.amount) : 0,
    });
  }

  // 银行流水里没有被任何平台记录认领的行。上面的循环只遍历 records（平台记录），
  // 所以永远不会主动看一眼「剩下哪些银行流水没被认领」——如果到这里不补一遍，
  // 这些行就会被静默丢弃：来源不明的汇款、退款回冲、误入账都会凭空消失，
  // 而这恰恰违反了本模板「宁可报未匹配，绝不吞掉差异」的第一原则。
  for (const b of bankRows) {
    if (b.consumed) continue;
    results.push({
      rec: null,
      bank: b,
      status: '来源不明入账',
      note: `银行流水入账 ${b.amount.toFixed(2)} ${b.currency}（参考：${b.reference || '无摘要'}），在全部平台报表记录中找不到匹配的订单——可能是未知来源汇款、退款回冲，或误入账，需人工核实来源`,
      countsInSummary: true,
      shortfallAmount: 0,
    });
  }

  return results;
}

function formatBreakdown(fee_breakdown) {
  return Object.entries(fee_breakdown)
    .map(([cat, amt]) => `${cat}:${amt.toFixed(2)}`)
    .join(';');
}

function buildReport(results) {
  const header = [
    'platform',
    'order_id',
    'currency',
    'gross',
    'fees',
    'fee_breakdown',
    'net',
    'settled_at',
    'bank_date',
    'bank_amount',
    'bank_currency',
    'status',
    'note',
  ];

  const rows = [header];
  for (const r of results) {
    if (r.rec) {
      rows.push([
        r.rec.platform,
        r.rec.order_id,
        r.rec.currency,
        r.rec.gross.toFixed(2),
        r.rec.fees.toFixed(2),
        formatBreakdown(r.rec.fee_breakdown),
        r.rec.net.toFixed(2),
        r.rec.settled_at,
        r.bank ? r.bank.date : '',
        r.bank ? r.bank.amount.toFixed(2) : '',
        r.bank ? r.bank.currency : '',
        r.status,
        r.note,
      ]);
    } else {
      // 来源不明入账：没有平台记录可对应，platform/order_id 等字段留空，
      // 银行侧字段照实填，方便和有平台记录的行用同一张表统一浏览。
      rows.push([
        '',
        '',
        r.bank.currency,
        '',
        '',
        '',
        '',
        '',
        r.bank.date,
        r.bank.amount.toFixed(2),
        r.bank.currency,
        r.status,
        r.note,
      ]);
    }
  }

  // 汇总：四类差异各一行，作为文件最后几行，供 `tail -5 report.csv` 校验
  // （平台少结/银行未到/汇率损耗/来源不明入账，这个顺序不能变——前三类是既有契约，
  // 新的一类追加在最后，保证 tail -5 依旧能看到前三类原有汇总行）
  const pad = () => header.slice(3).map(() => '');

  const under = results.filter((r) => r.countsInSummary && r.status === '平台少结');
  const missing = results.filter((r) => r.countsInSummary && r.status === '银行未到');
  const fxLoss = results.filter((r) => r.countsInSummary && r.status === '汇率损耗');
  const unclaimed = results.filter((r) => r.countsInSummary && r.status === '来源不明入账');

  const underTotal = round2(under.reduce((s, r) => s + r.shortfallAmount, 0));
  const missingTotal = round2(missing.reduce((s, r) => s + r.rec.net, 0));
  const fxLossTotal = round2(fxLoss.reduce((s, r) => s + r.shortfallAmount, 0));
  const unclaimedTotal = round2(unclaimed.reduce((s, r) => s + r.bank.amount, 0));

  rows.push(header.map(() => ''));
  rows.push(['汇总', '笔数', '金额合计（原始币种直接相加，跨币种汇总仅供参考）', ...pad()]);
  rows.push(['平台少结', String(under.length), underTotal.toFixed(2), ...pad()]);
  rows.push(['银行未到', String(missing.length), missingTotal.toFixed(2), ...pad()]);
  rows.push(['汇率损耗', String(fxLoss.length), fxLossTotal.toFixed(2), ...pad()]);
  rows.push(['来源不明入账', String(unclaimed.length), unclaimedTotal.toFixed(2), ...pad()]);

  return {
    rows,
    counts: {
      under: under.length,
      missing: missing.length,
      fxLoss: fxLoss.length,
      unclaimed: unclaimed.length,
    },
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input || !args.bank || !args.out) {
    console.error(
      '用法: node reconcile.js --input <平台报表目录> --bank <银行流水.csv> --out <report.csv>',
    );
    process.exit(1);
  }

  const dir = __dirname;

  let categories, rates, bankMap, whitelist;
  try {
    categories = readJSON(path.join(dir, 'mappings/categories.json'));
    rates = readJSON(path.join(dir, 'mappings/rates.json'));
    bankMap = readJSON(path.join(dir, 'mappings/bank.json'));
    whitelist = readJSON(path.join(dir, 'mappings/whitelist.json'));
  } catch (err) {
    console.error(`[错误] 读取 mappings/ 配置文件失败：${err.message}`);
    process.exit(1);
  }

  const whitelistKeys = new Set((whitelist || []).map((w) => w.key));

  let records, bankRows;
  try {
    if (!fs.statSync(args.input).isDirectory()) {
      throw new Error(`${args.input} 不是一个目录`);
    }
    records = loadPlatformRecords(args.input, categories);
    bankRows = loadBankRecords(args.bank, bankMap);
  } catch (err) {
    console.error(`[错误] 读取输入数据失败：${err.message}`);
    process.exit(1);
  }

  const results = reconcileRecords(records, bankRows, rates, whitelistKeys);
  const { rows, counts } = buildReport(results);

  try {
    fs.writeFileSync(args.out, toCSV(rows), 'utf8');
  } catch (err) {
    console.error(`[错误] 写入报告失败：${err.message}`);
    process.exit(1);
  }

  console.log(
    `对账完成：共处理 ${records.length} 条平台记录，${bankRows.length} 条银行流水。` +
      `差异 —— 平台少结: ${counts.under}，银行未到: ${counts.missing}，汇率损耗: ${counts.fxLoss}，` +
      `来源不明入账: ${counts.unclaimed}。报告已写入 ${args.out}`,
  );
  process.exit(0);
}

main();
