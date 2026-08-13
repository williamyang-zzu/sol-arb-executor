# Mainnet validation milestones

本文档记录 `sol-arb-executor` 已完成的可公开验证里程碑。这里只记录链上执行器的事实和
验证边界，不记录客户端机会发现、报价、方向选择或发送策略。

## 2026-08-10：首次主网盈利原子执行

- Program ID：`RoroSC7cukdtr1WFantguWKcZ9KTwqjnMRJYo9EcL51`
- 结果：同一轮受控主网测试中有两笔原子执行交易实现正向 WSOL 余额变化

### 成功交易

| 序号 | 交易 | 毛利润 | 毛收益率 | 基础网络费 | 净利润 | 净收益率 |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | [4z2yaSq4…MJADWL](https://solscan.io/tx/4z2yaSq4mWJpEXA6BgqupPbtVtztTDs2jZxhJPutXBAGeW5J3au35GEzU6E3FEBGuKB7rqHUyxisBTG5TtMJADWL) | 110,127 | 2.20254% | 5,000 | 105,127 | 2.10254% |
| 2 | [2FbjbgRd…GkaBfH](https://solscan.io/tx/2FbjbgRdV15zAATPnmYwVg5FaJ2yucxK5tPBnuAvx67eRGKSiFH6nLvm3ru5gdJLNBAn2jLJXV3krHSXcEGkaBfH) | 71,914 | 1.43828% | 5,000 | 66,914 | 1.33828% |

合计毛利润为 `182,041` lamports；仅扣除这两笔成功交易各自的基础网络费后，合计净利润为
`172,041` lamports。

## 2026-08-11：升级版本主网盈利原子执行

- Program ID：`RoroSC7cukdtr1WFantguWKcZ9KTwqjnMRJYo9EcL51`
- 结果：升级后的执行器再次完成主网原子执行，并产生正向 WSOL 余额变化

| 交易 | 落链 slot | 毛利润 | 毛收益率 | 基础网络费 | 净利润 | 净收益率 | CU |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| [w4rQNTKZ…8wMtb4](https://solscan.io/tx/w4rQNTKZrFnmgE2ZJzFfTaAjHkAWUCA8dmVcgWvUsLyUX8eURFT18Rw2y5tEapJpEoJGE8gnWH7J4KqDW8wMtb4) | 438,634,249 | 36,573 | 0.73146% | 5,000 | 31,573 | 0.63146% | 218,312 |

截至该笔交易，本文档固定的三笔成功执行合计毛利润为 `218,614` lamports；仅扣除三笔成功
交易各自的基础网络费后，合计净利润为 `203,614` lamports。

## 2026-08-13：链上执行容错性增强版完成发布前验收

- 状态：代码、构建和隔离环境真实协议兼容性验收已完成；主网升级签名待补充
- 变更边界：增强候选执行路径之间的故障隔离；单一候选不可用时不再阻断其他有效候选
- 接口兼容性：现有指令账户和公开参数接口保持不变
- 资源预算：受控成功路径最高消耗 `218,899 CU`，低于 `300,000 CU` 上限
- 自动化验证：`29` 项 Rust 测试、`9` 项 TypeScript 测试、类型检查和 Anchor 构建通过

本条只记录链上执行器的容错行为和验证结果。测试所用资产、市场、账户、输入参数、候选评估细节
及交易发送条件不公开。主网升级完成前，本条不构成该版本已经部署至主网的声明；升级签名确认后再
补充链上部署事实。

### 计算口径

毛利润直接取成功交易中交易者 WSOL Token Account 的链上余额变化：

```text
gross_profit = post_wsol_balance - pre_wsol_balance
net_profit = gross_profit - transaction_fee
```

表中的收益率以该笔交易的公开链上输入为分母。净利润只额外扣除了该笔交易的基础网络费，
不包含同轮其他交易、账户准备、Address Lookup Table 或其他基础设施成本。

### 验证边界

这些交易证明对应版本的执行器曾在 Solana 主网真实协议账户上完成原子执行，并产生正向
WSOL 余额变化。交易签名用于独立核验，不在本文档中展开路线、市场选择、参数配置或发送条件。

该里程碑不是安全审计、持续盈利证明或生产 SLA。协议升级、账户布局变化、Token 扩展、池流动性
和客户端输入仍可能影响后续交易结果。
