# 基于多智能体的海滨疗养智能康养服务系统

## 1 项目基线

系统面向退休长者、康复与慢病人群、亚健康中青年三类客人，提供入住评估、七日疗程、海滨项目预约、膳食、心理陪伴、健康数据和医护审核。客人端以对话为主，机构端以医护审核台为核心。

现有原型已经覆盖 109 条需求跟踪矩阵中的主要页面和演示路径，但属于演示档：数据在内存中、登录密码为明文、对话为脚本规则、天气潮汐为 mock 数据、缺少自动化测试和生产部署配置。本轮开发把它提升为可评审的 MVP 基线。

## 2 总体架构

```text
浏览器（React/Vite）
        │ REST/JSON + x-token（生产替换为 HttpOnly JWT）
Express API（鉴权、RBAC、业务编排）
        ├─ Orchestrator Agent：意图识别、任务分派、结果汇总
        ├─ Domain Agents：理疗、营养、运动、心理
        ├─ Deterministic Safety Layer：禁忌、潮汐、容量、审核门禁
        └─ Persistence：SQLite snapshot（MVP）→ PostgreSQL（上线）
```

大模型只负责自然语言理解和候选方案编排，不能绕过确定性安全层。所有健康档案、预约、方案状态变化均产生审计日志；慢病或禁忌命中时方案状态必须为 `pending_review`，任何入口的调整都重新走该门禁。

## 3 核心业务状态

| 对象 | 状态 | 说明 |
|---|---|---|
| 疗程 | `pending_review` / `active` / `rejected` / `superseded` | mandatory 方案通过医护后才可生效；auto 方案直接生效并进入抽检 |
| 预约 | `booked` / `cancelled` / `completed` / `no_show` | 创建前依次校验禁忌、潮汐海况、容量 |
| 审核 | `approve` / `modify` / `reject` / `resubmit` / `抽检` | 驳回原因作为重生成约束并保留历史 |
| 健康指标 | `manual` / `chat` / `device` | 血压、睡眠、步数、体重；单位和来源必须可追溯 |

## 4 Agent 协作契约

1. Orchestrator 接收用户文本，识别意图并调用工具：`get_profile`、`generate_plan`、`book_slot`、`change_meal`、`record_metric`、`adjust_plan`。
2. Domain Agent 返回结构化建议：项目/餐食/强度/情绪策略、依据、置信信息和所需约束。
3. Safety Layer 对结构化结果执行 R1-R5 规则，生成 `violations[]` 与 `reviewTier`。
4. Orchestrator 只汇总通过安全层的结果，向客人呈现卡片；需要审核时明确显示“待医护确认”。
5. 任何方案变更都记录 `plan.history`、`audit_logs`，并按客人当前档案重新计算审核级别。

## 5 非功能要求

- 安全：密码使用 Argon2id/bcrypt；生产环境启用 HTTPS、HttpOnly Cookie、CSRF 防护、登录限流和最小权限 RBAC。
- 可用性：API 健康检查、结构化日志、SQLite WAL；生产切换 PostgreSQL 并启用备份。
- 可解释：审核详情同时展示档案摘要、命中规则、健康数据引用和修改历史。
- 可访问：移动优先、字号不小于 14px、关键状态不只依赖颜色、长者操作路径不超过三步。
- 数据治理：健康数据最小化采集、按角色脱敏、支持导出/删除申请；演示数据不得用于真实医疗决策。

## 6 MVP 验收口径

- 三类演示客人均可完成登录、评估、疗程查看和日程展示。
- 高血压客人的温泉自动降级且疗程进入强制审核；医护通过后客人端同步更新。
- 皮肤破损客人无法预约海水浴/海泥；行动受限客人无法预约游泳训练。
- 下海项目在不安全潮汐时段置灰；容量满时无法新增预约。
- 对话“明日上午休息”会同步修改疗程并取消同窗口预约；mandatory 方案重新进入审核。
- 录入高血压指标后，系统调整当日安排并留下可追溯历史。
- 重启 API 后业务数据仍存在，重置演示数据后恢复种子状态。
