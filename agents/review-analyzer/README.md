# review-analyzer · 每日经营参谋

每天定时跑一次：读门店评价 → LLM 情感分析 → 场景四分法决策 → 输出**一条**「明日建议」写入 agentLog。

## 搬走复用

1. 整个目录作为云函数部署，环境变量：`LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL`，超时 60 秒
2. 配定时触发器（推荐每天 20:30，错开整点）
3. 换行业：改 index.js 里的差评关键词表 + seedKb 灌新知识包
4. 依赖集合：`reviews`（评价）、`agentLog`（输出）、`llmUsage`（保险丝）、`kb`（行业知识）

## 注意

- 「只推一条」是体验红线，别改成推多条
- 当日无评价时自动回看近 7 天并在 agentLog 标记 `dataWindow: "7d"`，别删这个兜底
