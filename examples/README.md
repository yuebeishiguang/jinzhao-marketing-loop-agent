# 示例数据说明（examples/）

## 这是什么

`demo-store-7day.json` —— 一家虚构门店「老街家常菜（示例店）」**2026-08-01 ~ 08-07 共 7 天**的全流程模拟数据，38 条记录覆盖 4 个集合：评价（feedbacks）15 条、领券/核销（coupons）13 张、预约（reservations）3 单、Agent 运行留痕（agentLog）7 次。

用途： fork 本模板后无需真实商家即可**复现完整 Agent 闭环演示**，也可直接导入微信云开发数据库做联调。

## 模拟逻辑（赛事手册 Q7 合规声明）

1. **为什么用模拟数据**：真实商家的评价、券、预约数据属于商家经营资产，本模板的数据最小化原则（不爬外部平台、不收非必要个人信息）同样适用于我们自己——示例只用虚构数据。
2. **怎么模拟的**：记录由产品真实集合 schema 逐字段手工编排，字段名、枚举值、时间格式与线上代码（`cloudfunctions/submitFeedback`、`claimCoupon`、`redeemCoupon`、`reservation`、`dailyPilot`）逐字一致；不是随机生成器产出，而是按一条**可复盘的经营故事线**设计（见下）。
3. **虚构声明**：店名、顾客、电话均为虚构；`phone` 已打码；线上库内部存的 `openid` 在本文件中一律替换为 `u_xxxxxx` 哈希占位（演示脱敏口径）；时间为东八区（+08:00）。

## 故事线（评委导读：顺着数据能看到 Agent 在干活）

| 天 | 发生了什么 | Agent 动作（看 agentLog） |
|---|---|---|
| 8-01 | 午餐高峰「上菜慢」差评 | 当晚 20:30 识别**差评安抚**场景 → 提议歉意券 → 老板「照办」（applied） |
| 8-02 | 差评顾客核销歉意券 | 复盘：发 1 核 1（100%），顾客未追加投诉 |
| 8-03 | 该顾客回访**转好评**，被 AI 自动精选 | 识别**好评裂变**场景：安抚见效，引导老客裂变 |
| 8-04 | 券核销率跌至 0% | **LLM 故障降级（fallback:true，0 token）仍输出调券方案**——门槛下调满 80 减 12 |
| 8-05 | 抖音渠道码带来首个核销新客；首单包厢预约 | 识别**渠道拉新加速**，渠道归因生效 |
| 8-06 | 6 位老客超 30 天未到店 | 提议**沉睡召回**，老板未审批 → `status:pending`（动钱的动作必须人批，这是设计原则） |
| 8-07 | 好评潮，「上菜改进」被顾客点名 | 复盘一周：核销率 0%→67%；提议生成周末种草文案 |

## 字段含义

### feedbacks（评价）

| 字段 | 含义 |
|---|---|
| shopId / tableId | 门店 ID / 桌码编号（评价来自扫码） |
| openid | 演示中为 `u_` 哈希占位；线上为微信 openid，内部使用不展示 |
| satisfaction | `satisfied` 满意 / `unsatisfied` 不满意（进私密意见箱） |
| content | 评价原文（入库前过微信 msgSecCheck 内容安全） |
| dish | 顾客点名的菜（可空），推荐菜榜数据源 |
| emotion | 细粒度归类：满意 / 口味 / 服务 / 环境 / 价格 / 其他 |
| featured / featuredBy | AI 自动精选标记与来源（仅满意评价参与精选） |
| read | 老板是否已读 |
| weekKey | 所在周（当周周一日期，YYYY-MM-DD），周报统计用 |
| createdAt | 创建时间（ISO 8601，+08:00） |

### coupons（领券 / 核销）

| 字段 | 含义 |
|---|---|
| code | 6 位数字核销码（全库唯一，商家核销时输入） |
| title / rule | 券面文案快照 / 结构化规则快照（发出后不随店家改设置变化） |
| rule.type | `threshold` 阶梯满减（按消费额自动匹配最高可用档） |
| status | `unused` 未用 / `used` 已核销 / `expired` 已过期 |
| via / channelId | 领取来源：`table` 桌码评价路径 / `channel` 渠道码拉新路径 + 渠道 ID（渠道归因） |
| openid / weekKey / createdAt / expireAt | 同上分口径；有效期默认 30 天 |
| usedAt / billAmount | 核销时间 / 核销时记录的本单消费金额 |
| appliedTier / discountAmount | 实际命中档快照 / 实际减免金额（看板与周报统计用） |

### reservations（预约）

| 字段 | 含义 |
|---|---|
| name / phone | 联系人 / 联系电话（顾客勾选《用户服务协议》《隐私政策》后主动填写；演示已打码） |
| date / time / scene / people | 到店日期 / 时间 / `hall` 堂食 或 `box` 包厢 / 人数 |
| dishes | 预点菜品数组（name + count） |
| note | 备注（过内容安全校验） |
| status | `pending` 待确认 / `confirmed` 已确认 / `arrived` 已到店 / `noshow` 未到店 / `cancelled` 已取消 |
| createdAt / updatedAt | 创建 / 最近更新时间 |

### agentLog（Agent 运行留痕，可审计）

| 字段 | 含义 |
|---|---|
| runAt / dataWindow | 运行时间（每天 20:30 定时触发）/ 数据窗口 |
| inputSummary | 输入摘要：当日评价数、好评率、提取关键词 |
| yesterdayReview | **效果复盘**：昨日发券/核销/差评动向（Agent 自我验证昨日策略，滚动迭代） |
| scene / sceneReason | 识别出的经营场景（好评裂变/差评安抚/沉睡召回/菜品优化/券策略调整/渠道拉新）与判定依据 |
| proposal | 输出方案：action、券规则、目标人数、自然语言建议 |
| fallback | `true` 表示 LLM 调用失败，已切换规则兜底模板（成本保险丝，0 token） |
| llm | 模型名 / token 用量 / 单次成本（元） |
| status / appliedAt / appliedBy | `pending` 待老板审批 / `applied` 已照办；动钱的动作不审批不执行 |

## 怎么用它复现演示

1. 云数据库建 4 个集合：`feedbacks`、`coupons`、`reservations`、`agentLog`
2. 在云开发控制台「数据库 → 导入」选择 `demo-store-7day.json`（或按集合拆分导入）
3. 打开商家看板：7 天数据、券核销明细（含消费/优惠/实付）、Agent 每晚建议与复盘即刻可见
