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

跑完会看到形如「差异 —— 平台少结: 1，银行未到: 1，汇率损耗: 1」的汇总，`report.csv` 末尾几行也是这三类差异的汇总行，`tail -5 report.csv` 能直接看到。

退出码：跑通即 0（哪怕报出差异也算成功——对账的价值就在于发现差异，不是消灭它）；输入目录/银行流水文件读不出来才会非零退出。

## 数据流

```
samples/platforms/*.csv  →  parsers/{amazon,shopify,tiktok}.js  →  统一记录
                                                                      ↓
samples/bank.csv  →  mappings/bank.json（表头映射，可选）  →  银行流水记录
                                                                      ↓
                              按「金额 + ±3 天日期窗口」匹配（mappings/rates.json 静态汇率折算）
                                                                      ↓
                                                            report.csv（逐笔 + 三类差异汇总）
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

## 差异分三类

匹配策略刻意保守：找不到足够可信的银行流水就报「未匹配」，绝不做模糊匹配把差异悄悄吞掉——这是对账工具的第一美德。

- **平台少结**：银行找到了同币种的对应流水，但到账金额明显低于平台报表里的净额——平台说好结这么多钱，实际打过来的更少。
- **银行未到**：±3 天窗口内完全找不到金额相近的银行流水——钱可能还没到账，也可能真的丢了，需要人工跟进。
- **汇率损耗**：平台按外币结算、银行按折算后的金额到账，但折算损耗超过 `mappings/rates.json` 里配置的 `loss_threshold_pct` 阈值（默认 3%）。

三类之外，如果银行到账金额明显**高于**预期（比如多笔合并入账），会标成「已匹配」但在备注里提示人工复核，不会被静默丢弃。

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
