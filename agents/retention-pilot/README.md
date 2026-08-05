# retention-pilot · 审批闸门

所有「动钱」动作的函数级闸门：AI 只生成方案，老板点「照办」后才真正落券/召回，并回写 agentLog 状态为 applied。

## 搬走复用

1. 整个目录作为云函数部署，无需 LLM 环境变量（它不调模型）
2. 入参：`{ agentLogId }`——校验该建议处于 pending → 执行落券 → 标记 applied
3. 通用性：任何「AI 建议 + 人工审批」场景都能套（改执行体即可）
4. 依赖集合：`agentLog`、`coupons`、`users`（召回场景）

## 注意

- **不要在调用方前端跳过它直接写 coupons**——闸门在函数层才有意义
- 重复点击做了幂等（pending 才执行），别删状态校验
