# reservation-perceive · 预约感知

把预约簿变成 Agent 的感知器官：今日/明日到店桌数人数包厢、预约点菜榜 TOP3、昨日爽约数——主控 Agent 的备菜提醒和接约决策全靠它。

## 搬走复用

1. 两种用法任选：
   - 整个目录作为云函数部署，`{ shopId }` 入参，返回 `{ reservations, reminder, pushText }`
   - 只搬三个函数（`perceiveReservations` / `prepReminder` / `resvPushText`）内嵌进主控——**推荐**
2. 依赖集合：`reservations`，字段约定：`{ shopId, date:'YYYY-MM-DD', people:Number, scene:'hall'|'box', dishes:[{name}], status:'pending'|'confirmed'|'noshow'|'cancelled' }`
3. 通用性：任何"预约制"业态直接套——餐厅订桌、美业约时段、诊所挂号，只是 scene 取值不同

## 为什么单独成组件

- 它是 Agent "自主读取新数据源"的证据：主控不需要人告诉它今天几桌，自己查
- 备菜提醒**故意走规则不走 LLM**："明日 X 桌 Y 人，Z 桌点了招牌鱼请备足"——这句话 LLM 全挂也必须在，所以它是纯函数

## 注意

- 读不到返回 `null`（不是空对象），调用方要按"数据源不可用"降级，别当"零预约"——两回事
- `noshowYesterday` 依赖店家或系统把未到单标记为 `noshow`；没标记流程就永远是 0
- 点菜榜只统计 pending/confirmed 的活单，取消单不进榜
