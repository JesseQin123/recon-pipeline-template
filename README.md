# recon-pipeline-template

多平台自动对账流水线模板。零依赖 Node.js（>=18），只用内置模块，CSV 解析/序列化是自己写的一个小工具（`lib/csv.js`）。

对应的方案卡：[registry/solutions/cross-border-ecommerce/auto-reconciliation-01.md](../../registry/solutions/cross-border-ecommerce/auto-reconciliation-01.md)；组件契约卡：[registry/components/recon-pipeline-template.md](../../registry/components/recon-pipeline-template.md)。

## 核心命令

```bash
node reconcile.js --input <平台报表目录> --bank <银行流水.csv> --out <report.csv>
```

先用自带示例数据跑通一遍：

```bash
npm run reconcile
# 等价于：
node reconcile.js --input samples/platforms --bank samples/bank.csv --out report.csv
tail -5 report.csv
```

跑完会看到形如「差异 —— 平台少结: 1，银行未到: 1，汇率损耗: 1，来源不明入账: 1」的汇总，`report.csv` 末尾几行是这四类差异的汇总行；前三类（平台少结/银行未到/汇率损耗）在 `tail -5 report.csv` 就能直接看到，第四类（来源不明入账）紧跟在后面一行。

退出码：跑通即 0（哪怕报出差异也算成功——对账的价值就在于发现差异，不是消灭它）；输入目录/银行流水文件读不出来才会非零退出。

## 数据流

```
samples/platforms/*.csv  →  parsers/{amazon,shopify,tiktok}.js  →  统一记录
                                                                      ↓
samples/bank.csv  →  mappings/bank.json（表头映射，可选）  →  银行流水记录
                                                                      ↓
                              按「金额 + ±3 天日期窗口」匹配（mappings/rates.json 静态汇率折算）
                                                                      ↓
                                                            report.csv（逐笔 + 四类差异汇总）
```

统一记录格式（每个 parser 的 `parse()` 都返回这个形状的数组）：

```js
{
  platform: 'amazon',        // 平台标识
  order_id: 'AMZ-1001',      // 订单号
  currency: 'USD',
  gross: 120.00,             // 订单原始金额
  fees: 29.70,               // 费用合计（正数）
  net: 90.30,                // 平台报表给出的净额/实际结算金额（直接取报表字段，不自己推算）
  settled_at: '2026-07-10',  // 结算日期
  fee_breakdown: { 佣金: 18.00, 物流: 6.50, 仓储: 1.20, 广告: 4.00 }, // 翻译后的科目明细
}
```

## 差异分四类

匹配策略刻意保守：找不到足够可信的银行流水就报「未匹配」，绝不做模糊匹配把差异悄悄吞掉——这是对账工具的第一美德。

- **平台少结**：银行找到了同币种的对应流水，但到账金额明显低于平台报表里的净额——平台说好结这么多钱，实际打过来的更少。
- **银行未到**：±3 天窗口内完全找不到金额相近的银行流水——钱可能还没到账，也可能真的丢了，需要人工跟进。
- **汇率损耗**：平台按外币结算、银行按折算后的金额到账，但折算损耗超过 `mappings/rates.json` 里配置的 `loss_threshold_pct` 阈值（默认 3%）。
- **来源不明入账**：反过来的情况——银行流水里有一笔入账，但在所有平台报表记录里都找不到对应的订单。可能是未知来源的汇款、退款回冲，或者干脆是误入账，需要人工核实来源。

> **和「银行未到」的区别**：「银行未到」是平台报表里有这笔订单、银行没收到钱；「来源不明入账」反过来，是银行确实收到了钱、但翻遍所有平台报表都对不上号。方向不同，处理方式也不同，所以分成两类分别汇总，不合并。

四类既定差异之外，如果银行到账金额明显**高于**预期（比如多笔合并入账），会标成「已匹配」但在备注里提示人工复核，不会被静默丢弃。

**已修复的缺陷**：早期版本的匹配逻辑只遍历平台记录去找银行流水，从未反过来检查「还有哪些银行流水没被任何平台记录认领」——结果是来源不明的入账（未知汇款、退款回冲、误入账）会被完全跳过，既不出现在逐笔明细里，也不计入汇总，且完全没有报错或警告。这直接违反了本模板自己在上面强调的「绝不吞掉差异」。现在 `reconcile.js` 在按平台记录匹配完成后，会再遍历一遍银行流水里所有未被认领（`consumed === false`）的行，把它们作为「来源不明入账」写入报告和汇总行。`samples/bank.csv` 里的 `UNKNOWN INBOUND TRANSFER`（350.00 USD）就是用来演示这一类差异的示例数据。

## mappings/ 里的四个文件

对账工具的价值不在代码量，而在这层"科目/币种/银行列名"翻译层——都是纯数据文件，店主或 agent 可以直接改，不用碰代码。

- **categories.json** —— 科目翻译表：把每个平台结算报表里五花八门的费用列名，翻译成统一的七个科目（佣金/广告/物流/仓储/退款/调整/其他）。新增平台时，在这里加一个同名小节。
- **rates.json** —— 静态汇率表（相对 `base` 币种）+ `loss_threshold_pct`（跨币种匹配允许的最大偏差百分比）。生产环境建议定期更新，或者改接实时汇率源。
- **bank.json** —— 银行流水表头映射示例。如果你的银行导出 CSV 表头不是统一的 `date/amount/currency/reference`（比如中文对公流水常见的"交易日期/发生额/币种/摘要"），就把原始表头映射到这四个字段名。示例数据里的 `samples/bank.csv` 本身已经是统一表头，所以默认这份映射不会被用到，它是给接入真实银行流水时参考的样例。
- **whitelist.json** —— 差异白名单，默认空数组 `[]`。首次真实对账后，把确认合理、不需要每周重复报的差异加进来，格式为：

  ```json
  [
    { "key": "amazon:112-3456789-1234567", "note": "长期活动折扣，已和用户确认", "added_at": "2026-08-10" }
  ]
  ```

  `key` 是 `平台:订单号`。命中白名单的记录，`report.csv` 里状态会变成「已匹配（白名单）」，也不计入汇总行的笔数/金额。

## 新增平台：适配器模式

复制 `parsers/_template.js` 为 `parsers/<平台名>.js`，实现 `parse(csvText, categories)`，返回统一记录数组即可——不用改 `reconcile.js` 的匹配/汇总逻辑。然后在 `reconcile.js` 顶部的 `PARSER_BY_PREFIX` 里加一行「文件名前缀 → 你的模块」的映射（约定：报表文件名以平台名开头，如 `lazada-xxx.csv`）。

## 边界（和组件卡里写的一致）

- 不处理增值税/关税合规，只做资金对账。
- 汇率按静态表估算损耗，不接实时行情；阈值可在 `mappings/rates.json` 配置。
- 银行流水需要用户自己导出 CSV；各家银行表头不同，`mappings/bank.json` 给了映射示例，实际接入时列名必须和用户逐项确认——猜错列名会产出看起来合理、实际是错的报告，这是对账工具最危险的失败模式。
