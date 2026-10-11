# API 基线快照（历史）

> **历史记录，不是现行 API 契约。** 本文只描述 `67813a1`（2026-09-23）快照中的 `index.js`、`auth.js`、`db.js`、`assistant.js`。当前组合工作区的路由、权限和数据表已变化；请以 [现行 API 与运行契约](API运行契约.md) 和当前源码为准。
>
> 本文描述源码实际行为，不把概要设计、MySQL SQL 或 RTM 目标当成已运行契约。后端子任务正在实现的字段白名单、资源授权和会话隔离，在本文件中单独标为“待本轮后端评审确认”，不得提前当作通过。

## 1. 总览

当前服务实际注册 19 个 HTTP API。基础路径是 `/api`，请求/响应使用 JSON；`express.json` 的请求体上限是 256 KB。成功查询通常返回 200，创建建议/院长意见返回 201；错误体当前统一为 `{ "error": "面向用户的中文原因" }`，但没有稳定的 `code` 或 `requestId` 字段。

### 1.1 角色与鉴权

- 公开路由：`GET /health`、`GET /news`、`GET /news/:id`、`GET /assistant/status`，以及允许匿名访问的 `POST /assistant/chat`。
- 登录账号角色只有 `guest`、`staff`、`dean`。`public` 只在 Agent 请求中代表匿名场景，不是可登录的数据库角色。
- 受保护请求发送 `Authorization: Bearer <token>`。代码不支持早期文档中的 `x-token`。
- token 是 `auth.js` 用 `AUTH_SECRET` 做 HMAC-SHA256 的轻量令牌，payload 含 `sub`、`role`、`exp`，有效期 8 小时；每个受保护请求会重新查询账号并要求 `status='active'`。
- 缺失、格式错误、签名不匹配、过期或账号不可用均返回 401。当前没有 refresh cookie、退出 API、登录限流或 HttpOnly 会话。
- `staffOnly` 允许 `staff` 与 `dean`；`deanOnly` 只允许 `dean`。这只是角色级控制，不等于工作人员与客人之间已经有资源级授权。

### 1.2 时间与字段命名

- 服务端 `now()` 生成 ISO 8601 UTC 字符串。
- SQLite 表和部分响应直接暴露 snake_case，例如 `profile.birth_date`、`profile.room_no`、`profile.emergency_contact`、`profile.check_in`、`profile.check_out`、`profile.updated_at`，以及 `guestSummary.health` 中未重新命名的列。
- 另一些查询显式转换为 camelCase，例如 `publishedAt`、`recordedAt`、`createdAt`、`updatedAt`、`authorName`、`roomNo`、`checkIn`、`checkOut`、`targetType`、`targetId`。
- 登录请求和 Agent 请求使用 camelCase/普通 JSON 字段；`PATCH /me/profile` 也读取 camelCase，但当前返回结构不是统一 camelCase。客户端不得假设所有接口能互换命名。

### 1.3 当前数据库与 API 的关系

当前实际数据库是 `DB_PATH` 指向的 SQLite 文件，默认 `项目源码/server/data/community-v2.sqlite`。已有 `users`、`guest_profiles`、`health_records`、`medical_advice`、`news`、`audit_logs`、`staff_reviews`、`assistant_messages`、简化 `health_intakes`。当前没有 MySQL 目标中的 `staff_guest_assignments` 或 `assistant_sessions` 表；也没有疗程、项目、预约、潮汐、膳食、情绪、指标审核等 API。

## 2. 19 个当前 API

| # | 方法与路径 | 当前权限 | 请求 | 当前响应与行为 |
| ---: | --- | --- | --- | --- |
| 1 | `GET /api/health` | 公开 | 无 | `{"ok":true,"service":"seaside-wellness-community","time":"<ISO>"}`。 |
| 2 | `GET /api/news` | 公开 | 无 | 新闻数组，每项为 `id`、`category`、`title`、`summary`、`body`、`cover`、`publishedAt`、`pinned`，按置顶和发布时间倒序。 |
| 3 | `GET /api/news/:id` | 公开 | 路径 `id` | 同一新闻对象；不存在返回 404 `{error}`。 |
| 4 | `POST /api/auth/login` | 公开 | `{username,password,role}`，role 为 `guest`、`staff` 或 `dean` | 成功 200 `{token,user}`；user 为 `id`、`username`、`role`、`name`、`phone`、`avatar`。账号、密码或角色不匹配返回 401。 |
| 5 | `GET /api/me` | Bearer | 无 | guest 返回 `guestSummary`；staff/dean 返回安全用户对象并附 `assignedCount`。当前 `assignedCount` 是所有 active 客人的总数，不是当前工作人员的负责数。 |
| 6 | `PATCH /api/me/profile` | Bearer 且必须 guest | 当前源码实际读取 `name`、`phone`、`gender`、`birthDate`、`roomNo`、`checkIn`、`checkOut`、`emergencyContact`、`chronic[]`、`allergies[]`、`mobility` | 返回更新后的 `guestSummary`；非 guest 返回 400。当前 `allowed` 变量未被使用，后端并未真正执行字段白名单。 |
| 7 | `POST /api/me/password` | Bearer | `{currentPassword,newPassword}` | 成功 200 `{"ok":true}`；当前密码错误或新密码非字符串/少于 8 位返回 400；新密码用 scrypt 重新加盐。 |
| 8 | `GET /api/me/health` | Bearer；guest 用本人，staff/dean 通过 query 指定客人 | 可选 `?guestId=<id>` | 数组项为 `id`、`type`、`value`、`unit`、`note`、`recordedAt`，按记录时间倒序。staff/dean 缺 `guestId` 返回 400，但当前不验证负责关系。 |
| 9 | `GET /api/me/advice` | Bearer；guest 用本人，staff/dean 通过 query 指定客人 | 可选 `?guestId=<id>` | 数组项为 `id`、`title`、`content`、`priority`、`status`、`createdAt`、`updatedAt`、`authorName`。staff/dean 当前不验证负责关系。 |
| 10 | `GET /api/staff/overview` | `staff` 或 `dean` | 无 | `{guests,activeAdvice,recent}`；计数和 recent 审计日志是全局查询，不按工作人员负责关系过滤。 |
| 11 | `GET /api/staff/guests` | `staff` 或 `dean` | 可选 `?q=<姓名或房间>` | 数组项为 `id`、`name`、`phone`、`roomNo`、`checkIn`、`checkOut`、`chronic[]`、`allergies[]`；当前返回所有 active guest，未按 assignment 过滤。 |
| 12 | `GET /api/staff/guests/:id` | `staff` 或 `dean` | 路径客人 `id` | 返回 `guestSummary` 并写 `guest.view` 审计；不存在或不是 guest 返回 404。当前只校验角色和存在性，不校验负责关系。 |
| 13 | `POST /api/staff/guests/:id/advice` | `staff` 或 `dean` | `{title,content,priority}`，priority 允许 `normal`、`important`、`urgent` | 成功 201 `{id,ok:true}`，写入 active 建议和审计；无效 priority 会降为 `normal`。当前任何 staff/dean 都可向任意存在客人直接写 active 建议。 |
| 14 | `GET /api/dean/staff` | 仅 dean | 无 | 工作人员数组，项为 `id`、`name`、`username`、`phone`、`status`、`createdAt`、`guestViews`、`adviceCount`。 |
| 15 | `GET /api/dean/staff/:id/logs` | 仅 dean | 路径工作人员 `id` | `{staff,logs,reviews}`；logs 最多 50 条，字段含 `targetType`、`targetId`、`createdAt`；工作人员不存在返回 404。 |
| 16 | `POST /api/dean/staff/:id/reviews` | 仅 dean | `{content}` | 非空且目标为 staff 时返回 201 `{ok:true,id}`，写 `staff_reviews` 和 `staff.review`；空内容 400，目标不存在 404。 |
| 17 | `GET /api/assistant/status` | 公开 | 无 | `{live,model,provider,fallback}`。只有同时配置 `LLM_BASE_URL` 和 `LLM_API_KEY` 时 `live=true`；不会返回 API key。 |
| 18 | `POST /api/assistant/chat` | 可匿名，也可 Bearer | `{role?,text,sessionId?,guestId?}` | 非空 text 成功返回 `{sessionId,reply,quickReplies,live,mode}`；空 text 400；已登录且 body role 与 token 角色不符 403；模型调用异常通常在函数内降级为 200，未捕获的处理错误才由路由返回 502。匿名 role 当前被服务端强制为 `public`，但 sessionId 没有所有权校验，认证后的 staff/dean 也没有 guestId 资源授权校验。 |
| 19 | `GET /api/agent/status` | Bearer | guest 可用本人；staff/dean 可带 `?guestId=<id>` | `{mode,orchestrator,agents[],humanGate}`，展示康养管家及领域 Agent 的规则状态。当前只返回编排状态，不执行疗程/预约/规则工具。 |

### 2.1 代表性请求与响应

登录：

```http
POST /api/auth/login
Content-Type: application/json

{"username":"guest_demo","password":"guest2026","role":"guest"}
```

```json
{
  "token": "<hmac-token>",
  "user": {
    "id": "guest_001",
    "username": "guest_demo",
    "role": "guest",
    "name": "林海宁",
    "phone": "13800000001",
    "avatar": ""
  }
}
```

客人读取自己的工作区：

```http
GET /api/me
Authorization: Bearer <token>
```

当前响应形状是：

```json
{
  "id": "guest_001",
  "username": "guest_demo",
  "role": "guest",
  "name": "林海宁",
  "phone": "13800000001",
  "avatar": "",
  "profile": {
    "user_id": "guest_001",
    "gender": "女",
    "birth_date": "1958-06-18",
    "room_no": "A-203",
    "check_in": "2026-09-12",
    "check_out": "2026-09-26",
    "emergency_contact": "林先生 13900000001",
    "chronic": ["高血压"],
    "allergies": ["虾"],
    "mobility": "可独立行走",
    "updated_at": "<ISO>"
  },
  "health": [],
  "advice": []
}
```

上例只展示关键字段，实际 seed 数据会包含健康记录和建议；`health`/`advice` 的字段形状以第 2 节为准。`password_hash` 不通过 `publicUser` 返回。

## 3. 当前安全与边界事实

### 3.1 `phone`、`emergencyContact`、`mobility` 白名单

概要设计和 MySQL 字典要求客人只能维护电话、紧急联系人和行动能力。当前后端并未做到：`PATCH /api/me/profile` 中的 `allowed = ['name','phone']` 没有被使用，后续 SQL 会把多个 body 字段写入 `users`/`guest_profiles`。因此下面是“待本轮后端评审确认”的目标契约，而不是当前已实现事实：

```json
{
  "phone": "可选字符串",
  "emergencyContact": "可选字符串",
  "mobility": "可选字符串"
}
```

后端任务需要确认并测试：

1. 只接受这三个字段，拒绝或明确忽略 `name`、`gender`、`birthDate`、`roomNo`、`checkIn`、`checkOut`、`chronic`、`allergies` 及未知字段。
2. 同时校验类型、长度和空值策略，成功写入审计；前端不得依赖“只读控件”作为唯一防线。
3. 返回字段命名要么保留现有兼容映射，要么在版本化契约中统一 camelCase；在后端评审确认前，不能把混合 snake_case/camelCase 写成稳定 API。

### 3.2 资源级授权

当前 `staffOnly` 只做角色判断。以下路径存在同一缺口：

- `/staff/guests` 返回所有 active 客人；
- `/staff/guests/:id` 和 `/staff/guests/:id/advice` 只查客人存在性；
- `/me/health`、`/me/advice` 和 `/agent/status?guestId=...` 接受 staff/dean 指定的任意客人编号；
- `/staff/overview` 的客人数、医嘱数、recent 日志是全局统计。

MySQL 目标通过 `staff_guest_assignments(staff_id,guest_id,status,...)` 表表达负责关系。当前 SQLite 没有该表，所以“工作人员只能访问负责客人，写入/健康查询/Agent 上下文均使用同一授权函数”是待本轮后端评审确认的契约。院长是否拥有机构级监督范围、是否绕过 assignment，需业务/后端评审明确，不能从当前通用 `dean` 角色直接推断。

### 3.3 Agent 会话隔离

当前 `assistant_messages` 只有 `session_id`、`user_id`、`role`、`content`、`created_at`，没有会话主表、owner、assistant role 或 related guest。`POST /assistant/chat` 会接受客户端提供的 sessionId，按该 id 读取最近 12 条消息；不会验证调用者是否创建过该会话，也不会把 role/guestId 绑定到会话。匿名请求的 role 会被服务端强制为 `public`，因此当前不会直接按匿名 role 装配私有客人上下文；但知道 sessionId 的其他调用者仍可能读到该会话历史，而认证后的 staff/dean 可把未授权 guestId 传入上下文。

待本轮后端评审确认的隔离约定是：

- 新会话由服务端生成并绑定匿名主体或 `userId`、effective role、related guest；
- 带 sessionId 的后续请求必须先通过 owner/role/guest 绑定校验，不能跨账号、跨角色、跨客人复用；
- 匿名 `public` 会话不能关联客人档案；登录 guest 只能关联本人；staff/dean 关联客人前必须通过资源授权；
- 角色以 token 为准，客户端 body 的 role 不能升级权限；
- 历史消息、模型上下文和 `health_intakes` 均只取已授权会话范围。

这些约定在后端测试与评审完成前均不标为已通过。

### 3.4 健康信息与人工审核

当前客人 Agent 输入命中“慢病、用药、过敏、睡眠、血压、疼、不适、康复”等关键词时，会把原始文本写入简化的 `health_intakes(guest_id,content,source,created_at)`；没有结构化字段、review status、reviewed_by 或审核 API。工作人员发布建议接口直接写 `status='active'`，没有 Agent 草稿/人工确认状态机。

MySQL 设计中的 `health_intakes.review_status` 和 `medical_advice.source/confirmed_by/confirmed_at` 属于后续迁移/审核阶段目标；不能用表设计代替当前运行证据。

## 4. 当前不提供的旧 API 与扩展能力

早期 `项目依据/03-api-contract.md` 的 `/programs`、`/programs/:id/slots`、`/profile`、`/chat/history`、`/plan`、`/plan/regenerate`、`/schedule`、`/reservations`、`/brief`、`/moods`、`/metrics`、`/checkin`、`/reviews`、`/rules` 等不在当前 19 路由内。疗程、预约、潮汐、容量、膳食、情绪、健康指标、审核队列、服务人员视图和反馈闭环均是扩展阶段，不应根据选题书、原型占位页或 MySQL 预留表宣称完成。

## 5. RTM 109 条逐项现状映射

状态含义：

- **部分覆盖**：当前源码有相邻路径或局部行为，但未达到该 RTM 的完整验收条件。
- **范围不同**：有相似概念，但角色、字段、流程或数据模型与该 RTM 不同，不能直接计为完成。
- **未实现**：当前源码没有可对应的页面、API、数据模型或业务流程。

RTM 原文件的跟踪列均为 `×`。以下映射是对当前源码的保守核对，不是把设计目标改写为通过证据。

| No. | RTM 功能点简述 | 当前状态 | 当前源码依据与缺口 |
| ---: | --- | --- | --- |
| 1 | 客人端/机构端双端与机构角色 | 范围不同 | 有公开、guest、staff、dean 页面，但无医护/管理员/服务人员独立角色和机构端全模块。 |
| 2 | 主色调与配色体系 | 范围不同 | 有自定义 CSS 主题，但未按 RTM 色值完整实现或验收。 |
| 3 | 适老化字号、点击区、对比度 | 范围不同 | 有响应式样式，但当前多个字号小于 RTM 要求，未完成可访问性测量。 |
| 4 | 桌面网页窗口适配（当前范围） | 部分覆盖 | 公开页、登录页和工作区使用统一页面尺度；窄桌面窗口重排导航及卡片，疗程/预约页面尚未实现。原矩阵范围按现行产品决定收窄。 |
| 5 | 对话主入口与页面直操作 | 部分覆盖 | 有 Agent 悬浮窗和资料/健康/医嘱页面，但无 RTM 规划结果页和预约操作。 |
| 6 | 全局提示、加载、危险操作确认 | 部分覆盖 | 有 loading、toast、Agent typing 和按钮禁用；无统一 2.5 秒规范及危险操作确认闭环。 |
| 7 | 客人五项网页导航与页面骨架 | 范围不同 | 当前有四项客人网页导航，尚未形成管家/日程/项目/膳食/我的五个入口。 |
| 8 | 登录控件组 | 范围不同 | 有用户名/密码登录和 guest/staff 入口；RTM 要求手机号、特定标题和注册入口。 |
| 9 | 注册页标题 | 未实现 | 没有注册路由或视图。 |
| 10 | 注册基础输入与校验 | 未实现 | 没有注册接口或表单校验。 |
| 11 | 注册按钮与登录切换 | 未实现 | 没有注册流程。 |
| 12 | 健康档案标题与在住信息 | 部分覆盖 | guest `/me` 与页面显示姓名、房间、入住/离店日期；在住状态仅以房间是否存在粗略判断。 |
| 13 | 慢病史与用药输入 | 范围不同 | 页面只读显示慢病标签，没有用药字段；当前后端反而会接受未白名单的 chronic。 |
| 14 | 过敏源与饮食忌口输入 | 范围不同 | 页面只读过敏标签，没有饮食忌口/安全硬约束流程。 |
| 15 | 行动能力与睡眠输入 | 范围不同 | 页面可编辑行动能力但无睡眠字段，且当前后端白名单未收紧。 |
| 16 | 档案保存按钮与校验 | 部分覆盖 | 有 PATCH 保存和提示，但无 RTM 完整必填/定位校验。 |
| 17 | 档案变更记录 | 未实现 | 没有档案版本/变更查询接口或表。 |
| 18 | 档案完整度提示 | 未实现 | 没有完整度计算或进度条。 |
| 19 | 对话采集写入档案 | 部分覆盖 | guest Agent 关键词会写原始 health_intakes；不会抽取、去重、更新档案或记录字段变更来源。 |
| 20 | 档案驱动推荐与禁忌校验 | 范围不同 | Agent context 会带部分档案且文案提醒安全，但无确定性规则层和推荐/疗程输出。 |
| 21 | 入住登记与疗程周期 | 部分覆盖 | 种子档案有入住/离店展示；没有入住登记、日期校验或疗程周期生成。 |
| 22 | 调度 Agent 意图识别与分派 | 范围不同 | 有角色提示词、规则回复和状态展示；没有真实领域任务识别/工具分派。 |
| 23 | 调度结果汇总与疗程编排 | 未实现 | 没有结构化疗程、冲突消解或预约变更。 |
| 24 | 理疗建议与禁忌校验 | 范围不同 | 状态文案列出理疗顾问，通用回复有安全提醒；没有水疗项目/规则库匹配。 |
| 25 | 营养师三餐搭配 | 范围不同 | 有 Agent 角色概念，无菜品库或三餐 API/页面。 |
| 26 | 运动强度安排 | 范围不同 | 有运动教练状态文案，无项目强度匹配和安排。 |
| 27 | 心理陪伴策略 | 范围不同 | 有通用 guest 对话，无画像化心理 Agent、心情记录或资源。 |
| 28 | 知识库与规则库 | 未实现 | SQLite schema 没有知识/规则实体，Agent 不返回规则编号。 |
| 29 | Agent 业务工具调用 | 未实现 | 没有项目查询、预约、点餐、档案工具调用接口。 |
| 30 | 超时、失败降级与告警 | 部分覆盖 | 模型请求异常会安全降级；没有 fetch 超时、失败日志告警或 >15 秒处理契约。 |
| 31 | 对话页标题栏 | 部分覆盖 | AssistantWidget 有按角色标题和在线/安全模式状态；无当前客人姓名标题栏。 |
| 32 | 消息流与结果卡片 | 部分覆盖 | 有文本消息流和快捷回复；无历史分页、项目/餐食结果卡片。 |
| 33 | 输入区与快捷指令 | 部分覆盖 | 有输入框、发送按钮和服务端 quickReplies；不是 RTM 指定全套业务快捷指令。 |
| 34 | 思考中状态 | 部分覆盖 | 有“正在整理你的信息”动画并禁用发送；未验证全局一致性。 |
| 35 | 动态追问与模糊表达澄清 | 部分覆盖 | fallback 会问慢病、用药、睡眠等问题；没有评估骨架、进度保存和结构化入档。 |
| 36 | 七日疗程与周期调整 | 未实现 | 没有 plan/疗程数据模型或 API。 |
| 37 | 每日三时段编排规则 | 未实现 | 没有时段安排、餐后间隔或开放时段校验。 |
| 38 | 疗程总览卡片 | 未实现 | 没有疗程页面或状态卡。 |
| 39 | 对话调整休息/更换项目 | 未实现 | Agent 不执行计划、预约释放或替换。 |
| 40 | 方案依据与禁忌展示 | 未实现 | 没有知识/规则编号、方案依据或审核详情。 |
| 41 | 项目库分类筛选 | 未实现 | 没有项目库路由、表或页面。 |
| 42 | 项目卡片列表 | 未实现 | 没有项目数据。 |
| 43 | 项目搜索 | 未实现 | 没有项目搜索 API/UI。 |
| 44 | 项目详情与禁忌 | 未实现 | 没有项目详情或禁忌数据。 |
| 45 | 潮汐与海况状态条 | 未实现 | 前端天气是随机演示值，没有潮汐/海况源。 |
| 46 | 可预约时段网格 | 未实现 | 没有 slot API 或容量网格。 |
| 47 | 预约按钮与结果 | 未实现 | 没有预约创建接口。 |
| 48 | 不安全时段置灰原因 | 未实现 | 没有潮汐安全判定。 |
| 49 | 我的预约列表 | 未实现 | 没有 reservation 表/API。 |
| 50 | 潮汐安全校验 | 未实现 | 没有安全层或下海项目标记。 |
| 51 | 容量控制与并发 | 未实现 | 没有容量扣减、锁或幂等实现。 |
| 52 | 管家代办预约 | 未实现 | Agent 没有预约工具。 |
| 53 | 预约单与日程同步 | 未实现 | 没有预约单、日程或状态同步。 |
| 54 | 项目库数据结构 | 未实现 | 没有项目实体，MySQL目标脚本也不是当前运行 schema。 |
| 55 | 简报头部 | 未实现 | 没有每日简报页面或任务。 |
| 56 | 今日安排摘要 | 未实现 | 没有疗程/日程数据。 |
| 57 | 天气与潮汐卡 | 范围不同 | 首页有随机演示天气卡，但无每日简报和潮汐真实/缓存数据。 |
| 58 | 健康提醒卡 | 未实现 | 没有按档案、用药或安排生成提醒。 |
| 59 | 清晨推送 | 未实现 | 没有定时任务、站内通知或推送。 |
| 60 | 当日时间线 | 未实现 | 没有日程时间线。 |
| 61 | 全疗程视图 | 未实现 | 没有疗程周期视图。 |
| 62 | 项目开始提醒 | 未实现 | 没有浏览器通知或提醒任务。 |
| 63 | 项目打卡与感受反馈 | 未实现 | 没有 check-in/feedback 数据。 |
| 64 | 反馈记录查看 | 未实现 | 没有反馈历史接口。 |
| 65 | 膳食标题与日期切换 | 未实现 | 没有膳食页面。 |
| 66 | 三餐推荐卡 | 未实现 | 没有菜品或餐食推荐。 |
| 67 | 换菜按钮 | 未实现 | 没有换菜流程。 |
| 68 | 点餐预约按钮 | 未实现 | 没有点餐记录或接口。 |
| 69 | 三餐生成逻辑 | 未实现 | 没有营养规则、菜品库或生成结果。 |
| 70 | 客群差异化膳食 | 未实现 | 没有客群策略或餐食输出。 |
| 71 | 对话换菜 | 未实现 | Agent 不更新菜单/点餐。 |
| 72 | 点餐单结构与配餐视图 | 未实现 | 没有点餐实体和服务人员页面。 |
| 73 | 心情入口与快捷选择 | 未实现 | 没有 mood 表、心情控件或记录 API。 |
| 74 | 画像化陪伴对话 | 范围不同 | 有通用 guest AssistantWidget，但无心理路由、画像差异和持续陪伴资源。 |
| 75 | 冥想与放松课程卡 | 未实现 | 没有课程/媒体资源。 |
| 76 | 环境音播放器 | 未实现 | 没有音频资源或播放器。 |
| 77 | 心情打卡控件 | 未实现 | 没有每日 mood 写入/修改规则。 |
| 78 | 情绪趋势图 | 未实现 | 没有情绪记录或趋势 API。 |
| 79 | 画像化陪伴策略 | 未实现 | Agent 角色提示词没有依据客群画像执行的策略链。 |
| 80 | 情绪趋势联动疗程 | 未实现 | 没有疗程和情绪回流。 |
| 81 | 血压/睡眠/步数/体重录入 | 未实现 | 当前仅展示已有 health_records，没有客人指标写入表单。 |
| 82 | 指标趋势图 | 未实现 | 没有趋势查询或图表数据。 |
| 83 | 健康记录列表、来源与删除 | 部分覆盖 | guest 页面可读列表；没有来源字段统一输出、当日删除或客人录入。 |
| 84 | 健康数据回流调整 | 未实现 | 没有指标触发器、疗程调整或审核门禁。 |
| 85 | 指标数据结构与来源 | 未实现 | 当前 health_records 只有简单 type/value/unit/note，缺少四类指标规范和 source。 |
| 86 | 审核队列统计卡 | 未实现 | 没有 plan review 表/API/页面。 |
| 87 | 审核队列筛选排序 | 未实现 | 没有审核队列。 |
| 88 | 审核任务行 | 未实现 | 没有方案审核任务。 |
| 89 | 审核详情修改 | 未实现 | 没有方案安排或审核保存。 |
| 90 | 生成依据区 | 未实现 | 没有结构化评估、规则/知识引用。 |
| 91 | 通过/修改/驳回 | 未实现 | 当前建议发布不是疗程审核状态机。 |
| 92 | 直接生效与抽检 | 未实现 | 没有分级审核或抽检池。 |
| 93 | 强制审核拦截 | 未实现 | 没有 pending_review 方案状态。 |
| 94 | 驳回重生成 | 未实现 | 没有驳回原因、新方案关联或重生成。 |
| 95 | 禁忌规则列表 | 未实现 | 没有规则表/查询 API；Agent 文本提醒不构成规则列表。 |
| 96 | 审核历史查询 | 未实现 | 没有审核记录实体或查询。 |
| 97 | 机构客户列表 | 部分覆盖 | staff 客人列表按姓名/房间搜索并显示部分档案；无年龄、在住筛选、机构角色矩阵。 |
| 98 | 客户只读档案与变更记录 | 部分覆盖 | staff 客人详情可读基础/健康/医嘱；无档案变更记录入口，资源授权也未完成。 |
| 99 | 项目排期总览 | 未实现 | 没有项目时段和容量数据。 |
| 100 | 预约按日/按项目视图 | 未实现 | 没有预约数据或视图。 |
| 101 | 预约异常处理 | 未实现 | 没有取消、no-show、天气原因或批量操作。 |
| 102 | 员工账号列表与岗位 | 范围不同 | dean 可读 staff 列表，但没有新增/停用、医护/管理员/服务岗位字段。 |
| 103 | 角色权限矩阵 | 范围不同 | 只有 guest/staff/dean 中间件，没有 RTM 岗位×功能矩阵。 |
| 104 | 服务人员每日安排 | 未实现 | 没有服务人员角色、排班或项目名单。 |
| 105 | 点餐备餐单 | 未实现 | 没有点餐和配餐员视图。 |
| 106 | 机构端登录与跳转 | 部分覆盖 | Bearer 登录后按 guest/staff/dean 渲染空间；无医护/服务人员/管理员路由和手机号注册登录。 |
| 107 | 角色业务权限规则 | 范围不同 | 有 staff/dean 粗粒度 RBAC，但没有 RTM 的医护/管理员/服务人员权限与审计规则。 |
| 108 | 评估—执行—反馈—再调整 | 未实现 | 没有项目执行反馈、疗程再评估或新方案。 |
| 109 | 变更方案重新审核一致性 | 未实现 | 没有方案变更、禁忌复算、分级审核和历史链路。 |

## 6. 本轮待评审契约清单

以下项目不能用本文“当前 API”章节替代实现，需要后端完成后由主任务复核：

1. `/api/me/profile` 只允许 `phone`、`emergencyContact`、`mobility`，并决定未知字段返回 400 还是忽略。
2. `/api/staff/guests*`、`/api/me/health`、`/api/me/advice`、`/api/agent/status` 和 Agent 上下文统一经过工作人员—客人资源授权；staff/dean 的差别要有明确业务规则。
3. Agent sessionId 绑定用户/角色/客人，匿名 public 不得读取私有上下文；跨账号、跨角色、跨客人复用必须失败且不泄露历史。
4. 模型调用增加可测试的超时和安全降级；自动化测试只使用临时 SQLite 和本地规则/Stub，不读取真实密钥或访问真实模型。
5. 字段命名兼容策略、健康采集审核状态和医嘱人工确认状态在迁移 MySQL 前冻结版本化契约。
