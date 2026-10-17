# Mainnet validation milestones

本文档记录 `sol-arb-executor` 已完成的可公开验证里程碑。这里只记录链上执行器的事实和
验证边界，不记录私有机会发现、报价、方向选择或发送策略。经明确要求记录的客户端接入验收标签，
会单独标明运行侧证据来源，不把它当作仅凭链上交易即可推断的事实。

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

## 2026-08-14：Pump cashback 兼容版本完成主网验证

- Program ID：`RoroSC7cukdtr1WFantguWKcZ9KTwqjnMRJYo9EcL51`
- 能力状态：支持 Pump cashback 相关账户的执行器版本已部署至主网并完成真实协议验证
- 兼容性结果：验证期间未出现 cashback 账户兼容错误；既有公开指令接口保持兼容
- 执行结果：升级后的执行器完成一笔盈利原子执行，交易者目标 Token 余额在交易结束后恢复至初始值

| 交易 | 落链 slot | 区块内索引 | 毛利润 | 毛收益率 | 网络费 | 净利润 | 净收益率 | CU |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| [5fqXR4uV…S5Bav](https://solscan.io/tx/5fqXR4uVHgYhNocxyyqXr76BEsqBuzvfu3mhFgVCT62reNWc9u1xZ49FSTKcfQgkzrgWFoScyPPeSbhK1vuS5Bav) | 439,195,088 | 410 | 380,512 | 7.61024% | 5,900 | 374,612 | 7.49224% | 217,595 |

`区块内索引` 采用链上原始数据的零基 `transactionIndex`；该交易对应区块内第 `411` 笔交易。

截至本条里程碑，本文档固定的四笔成功执行合计毛利润为 `599,126` lamports；仅扣除四笔
成功交易各自的网络费后，合计净利润为 `578,226` lamports。

本条不公开 cashback 账户构造细节、测试资产、市场、执行方向、输入参数、候选评估方式或交易
发送条件。交易签名仅用于独立验证主网执行事实。

## 2026-09-29：动态金额模式完成主网盈利执行验证

- Program ID：`RoroSC7cukdtr1WFantguWKcZ9KTwqjnMRJYo9EcL51`
- 结果：有界动态金额指令在主网完成两笔盈利原子执行，并在配置范围内选择了不同于最小值的实际投入金额
- 执行完整性：两笔交易结束后，交易者目标 Token 余额均恢复至执行前状态

| 交易                                                                                                                              |   落链 slot | 区块内索引 | 方向           |   实际投入 | 毛利润 |  毛收益率 | 网络费 | 净利润 |  净收益率 |      CU |
| --------------------------------------------------------------------------------------------------------------------------------- | ----------: | ---------: | -------------- | ---------: | -----: | --------: | -----: | -----: | --------: | ------: |
| [3o1HXS2o…N4S5D6](https://solscan.io/tx/3o1HXS2oXQJZVa1wKzmL6ybzFUowaV5XrgD9qFes1LGfwELXi3ft6r6Jx61zg8wHAK5VpWxev4CX9XX5ADN4S5D6) | 451,536,353 |        474 | Meteora → Pump | 12,785,591 | 45,546 | 0.356229% |  5,105 | 40,441 | 0.316301% | 247,981 |
| [dmCBHKfa…eng1NnB](https://solscan.io/tx/dmCBHKfabjG7apCE1dXGt5qHyiKHCynxb4HimmPpRfku9bidFDxKG7SC3uvnUWpGuy7GzLWupWBTBTc7eng1NnB) | 451,536,363 |        300 | Meteora → Pump | 12,904,964 | 70,118 | 0.543341% |  5,105 | 65,013 | 0.503783% | 239,786 |

金额单位均为 lamports。两笔交易合计毛利润为 `115,664` lamports；仅扣除这两笔成功交易各自
网络费后，合计净利润为 `105,454` lamports。加上前述四笔里程碑交易，本文档固定的六笔成功
执行合计毛利润为 `714,790` lamports，合计净利润为 `683,680` lamports。

机器可读记录已加入
[`tests/fixtures/mainnet-execution-milestones.json`](../tests/fixtures/mainnet-execution-milestones.json)，
其中固定了公开交易事实、动态金额选择事件和执行资源数据。该样本可用于历史交易证据回归；由于
未保存交易边界处全部协议账户的历史字节，不能把当前池状态或单纯修改 Surfpool slot 当作这两笔
交易的确定性历史反事实回放。

本条不记录 RPC、钱包文件、账户密钥、发送基础设施或机会触发规则。公开池地址仅保存在机器可读
样本中，用于协议兼容性和未来历史 prestate 补齐工作。

## 2026-09-30：动态金额扩大搜索范围后完成主网盈利执行

- Program ID：`RoroSC7cukdtr1WFantguWKcZ9KTwqjnMRJYo9EcL51`
- 结果：动态金额指令在 `0.005～0.25 SOL` 的受控范围内完成一笔盈利原子执行
- 选择结果：账户余额和报价覆盖均允许搜索至 `0.25 SOL`，链上搜索最终选择 `0.005 SOL`
- 执行完整性：交易结束后，交易者目标 Token 余额恢复至执行前状态

| 交易 | 落链 slot | 区块内索引 | 方向 | 实际投入 | 毛利润 | 毛收益率 | 网络费 | 净利润 | 净收益率 | CU |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| [5P1vfhhQ…AiRjGGK](https://solscan.io/tx/5P1vfhhQ1qUSUo36ZVaSK45XF2nBVLutRYhAi5wJ3eBbhms5bquRSkrUQTfSpNdNvQrRmWCttwk3Ft18AAiRjGGK) | 451,867,832 | 1,129 | Pump → Meteora | 5,000,000 | 10,812 | 0.216240% | 5,105 | 5,707 | 0.114140% | 349,830 |

金额单位均为 lamports。该交易的 `DynamicAmountSelected` 公开事件、执行池地址、资源消耗和
WSOL 余额变化已经加入机器可读回归样本。该事实证明最小金额仍被动态搜索保留并可被选中；它
不证明任何特定市场条件下都应选择最小金额。

截至本条里程碑，机器可读样本中固定的七笔成功执行合计毛利润为 `725,602` lamports；仅扣除
七笔成功交易各自网络费后的合计净利润为 `689,387` lamports。

本条不记录 RPC、钱包文件、账户密钥、发送基础设施、触发交易或机会发现规则。

## 2026-10-15：Helius Sender SWQoS-only／50 TPS 阶段首笔已记录成功

- Program ID：`RoroSC7cukdtr1WFantguWKcZ9KTwqjnMRJYo9EcL51`
- 运行侧验收标签：接入 Helius Sender SWQoS-only，并将目标发送频率提高至 `50 TPS` 后的首笔
  已记录成功套利。此标签来自用户确认的运行配置和独立 Monitor 记录；不能仅凭链上 tip 证明发送路径。
- 链上执行：动态金额、Pump → Meteora；目标 Token 余额在执行结束后恢复至初始值。

| 交易 | 落链 slot | 实际投入 | 毛利润 | 毛收益率 | 网络费 | 实付 tip | 净利润 | 净收益率 | CU |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| [2xCLXgW2…n3jFUGA](https://solscan.io/tx/2xCLXgW2xtSRXZ8nv6HAPZMYmnqgVJUpHqy6GmastzAS3uvV4ZhieXgNXMzxLYJCJMefpZMuxuasmM8Urn3jFUGA) | 457,111,148 | 7,547,432 | 16,315 | 0.216166% | 5,090 | 5,000 | 6,225 | 0.082478% | 263,057 |

金额单位为 lamports。链上时间为 `2026-10-15 04:53:11 UTC`（北京时间 `12:53:11`）。网络费
已包含优先费，tip 单独扣除，不能重复计入网络费。WSOL 余额从 `253,536,734` 增至 `253,553,049`；
交易者原生 SOL 扣减为 `10,090` lamports，等于网络费加实付 tip。区块内索引尚未核实，样本保留
`null`，不填零。

公开 `DynamicAmountSelected` 事件显示：余额和完整报价覆盖均允许搜索至 `25,000,000` lamports，
最终选择 `7,547,432`，预计输出 `7,563,747`，预计利润与实际 WSOL 增量一致。该样本可作为
动态金额、真实协议执行、Sender tip 成本扣除和非 WSOL 余额恢复的基准证据。

机器可读记录位于
[`tests/fixtures/mainnet-execution-milestones.json`](../tests/fixtures/mainnet-execution-milestones.json)。
可先执行不访问网络、不加载 `.env` 或钱包的样本一致性检查：

```bash
npm run test:mainnet-milestones:offline
```

需要再次核验链上原始交易时，再由操作者配置历史 RPC，运行既有 `test:mainnet-milestones` 只读证据
回归。尚未保存交易边界前的完整协议账户字节，因此本样本不是可直接确定性回放的历史 Surfpool 快照。

截至本条，机器可读样本共八笔成功交易，合计毛利润 `741,917` lamports；扣除这些成功交易各自网络费
和本条实付 tip 后为 `695,612` lamports。这不是全轮净收益：本条所在测试轮扣除全部交易及 ATA 创建
手续费后、未计可回收租金的净结果为 `-26,207,095` lamports，不能把单笔成功描述成整轮盈利。

除用户明确要求的接入方式和目标 TPS 标签外，不记录端点、地区、密钥、钱包文件、触发交易、事件
门槛、Burst 配置、抢占规则或其他私有策略参数。

## 2026-10-17：新增两笔动态金额主网成功执行样本

- Program ID：`RoroSC7cukdtr1WFantguWKcZ9KTwqjnMRJYo9EcL51`
- 结果：同一轮受控主网测试新增两笔盈利原子执行，均由动态金额指令选择实际投入金额。
- 证据：已只读核验交易原始数据、`DynamicAmountSelected` 事件、交易者 WSOL 与原生 SOL
  余额变化；两笔交易的目标 Token 余额均恢复至执行前状态。

| 交易 | 落链 slot | 区块内索引 | 实际投入 | 毛利润 | 毛收益率 | 网络费 | 实付 tip | 净利润 | 净收益率 | CU |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| [24HkWA3A…w5Td7ock](https://solscan.io/tx/24HkWA3A6wMbQVRW7fdTzt1o5Enx2LnwgeAvg4AqpHEubdJ142GEWGVMBUPTPTcs6LxpRykkDgS47sbaw5Td7ock) | 457,974,740 | 711 | 25,000,000 | 207,203 | 0.828812% | 5,090 | 5,000 | 197,113 | 0.788452% | 253,194 |
| [37JwTSko…xH4GWLec](https://solscan.io/tx/37JwTSkodH7xgLnK3LjTt5MUXXQbmrP39qQpcopa2pDzcUNqMTdjuey2EoG4x6qjGCFE1r4rPp1KBmfSxH4GWLec) | 457,975,617 | 932 | 25,000,000 | 230,381 | 0.921524% | 5,090 | 5,000 | 220,291 | 0.881164% | 254,631 |

金额单位为 lamports，区块内索引为零基。链上时间分别为 `2026-10-17 08:44:35 UTC`、
`08:47:43 UTC`（北京时间 `16:44:35`、`16:47:43`）。两笔公开事件均记录 Pump → Meteora，
实际投入为 `0.025 SOL`，事件预计利润分别等于实际 WSOL 增量。网络费已包含优先费，实付 tip
单独扣除；交易者原生 SOL 每笔扣减 `10,090` lamports，等于该笔网络费加实付 tip。

两笔合计毛利润 `437,584` lamports（`0.000437584 SOL`），扣除各自网络费和实付 tip 后为
`417,404` lamports（`0.000417404 SOL`）。这不是整轮盈利：同轮全部交易及 ATA 创建手续费计入后、
不计可回收账户租金的净结果为 `-41,223,616` lamports（`-0.041223616 SOL`）。

公开池地址、余额、事件字节、费用与 CU 已追加至既有
[`tests/fixtures/mainnet-execution-milestones.json`](../tests/fixtures/mainnet-execution-milestones.json)，
继续由 `npm run test:mainnet-milestones:offline` 检查本地样本一致性，并由既有只读
`test:mainnet-milestones` 验证历史交易证据。本条没有新增自动广播或钱包加载入口。
未保存交易边界前完整协议账户状态，不能将该记录当作可直接确定性回放的 Surfpool 历史快照。

截至本条，机器可读样本共十笔成功交易，合计毛利润 `1,179,501` lamports；扣除这些成功交易
各自网络费和已记录实付 tip 后为 `1,113,016` lamports。这里只汇总已固定的成功样本，不代表
系统累计或整轮收益。本条不记录触发交易、事件门槛、Burst 参数、抢占规则、端点、凭据或钱包文件。

## 动态金额上线前：固定金额成功回归语料

以下七笔主网成功交易来自动态金额模式引入前的一轮固定金额执行测试。这里仅固定公开交易签名，
用于后续完成固定金额与动态金额的报价、方向选择和执行结果 parity 验证；不记录钱包路径、RPC、
发送条件或其他私有运行配置。

| 序号 | 交易 |
| ---: | --- |
| 1 | [23dUPBYx…rAszaMRC](https://solscan.io/tx/23dUPBYxhn8hB8iJgBJQtQgRqJLnM1TPffXwjYDGZmMN6F5TWJktKX1GuBtNKCxfsMMufuD7jBjGqDBnrAszaMRC) |
| 2 | [2CJrGgZWL…4t1DCiw](https://solscan.io/tx/2CJrGgZWLn2Tgg3raBN6stUzvf2zcQwCeUNeBeNA6gjeKDM6V52VuowPW8QCqR65SniLKQDFeZKtFTyAc4t1DCiw) |
| 3 | [4Cq4dF8sY…mDALqSrW](https://solscan.io/tx/4Cq4dF8sY7UcxYpM3WiWCFqqoBeiLa5ebxiQqS7GTbv7rrBK8SGmyFnr3P9NqwGeBWFgo7odK6cATRJPmDALqSrW) |
| 4 | [oY2RC1ash…apRxDVUUW](https://solscan.io/tx/oY2RC1ash1gnY36RbVAicE26y1nXUPrQNE7sHpYpByWzZkaWofQwaG2zLuBnKjuDVyeara1tZpmQ1rapRxDVUUW) |
| 5 | [3Po6gRtX5…s84rwaKEe](https://solscan.io/tx/3Po6gRtX5cnTp5r8YkEWNiYKhadczetSymCScpssHb6NLvpvzurHvmdJhzbcGxN3ifCfnxdfaJ9k9Cjs84rwaKEe) |
| 6 | [35QDvww8W…VLfz5QRAn](https://solscan.io/tx/35QDvww8WTNMZsQniJG3oogorVadxTwgUEGHEVtvSF94nj4W8BgcN3L744qaUPYXEZ3RNgwZMzxqsnpVLfz5QRAn) |
| 7 | [4WDL8gzQS…vSQvF5g81s](https://solscan.io/tx/4WDL8gzQSjz418oZqjR6eLUq4HFvqSBfRNUN42YMqPiJ5TxovTRqWe9S7ZiLjcKyk9HBDMRKtKYSovvSQvF5g81s) |

机器可读清单位于
[`tests/fixtures/pre-dynamic-fixed-amount-successes.json`](../tests/fixtures/pre-dynamic-fixed-amount-successes.json)。
当前清单的证据等级为 `signature-only`：尚未提交每笔交易边界处的完整历史账户字节，因此不能把
当前池状态或单纯修改 Surfpool slot 当作当时盈利状态的确定性回放。补齐历史 prestate 后，这七笔
应作为动态金额发布门槛：固定金额成功时，动态模式的最小金额候选不得被遗漏。

### 计算口径

毛利润直接取成功交易中交易者 WSOL Token Account 的链上余额变化：

```text
gross_profit = post_wsol_balance - pre_wsol_balance
net_profit = gross_profit - transaction_fee - paid_tip
```

表中的收益率以该笔交易的公开链上输入为分母。既有无独立 tip 的记录沿用只扣网络费的口径；新增
Sender 样本额外扣除链上实际支付的 tip。净利润只扣该笔交易自身的网络费与已记录的实付 tip，
不包含同轮其他交易、账户准备、Address Lookup Table 或其他基础设施成本。

### 验证边界

这些交易证明对应版本的执行器曾在 Solana 主网真实协议账户上完成原子执行，并产生正向
WSOL 余额变化。交易签名用于独立核验，不在本文档中展开私有机会发现、市场筛选或执行触发条件。

该里程碑不是安全审计、持续盈利证明或生产 SLA。协议升级、账户布局变化、Token 扩展、池流动性
和客户端输入仍可能影响后续交易结果。
