# 现行 API 与运行契约

> 本文描述当前组合工作区中的实现，依据 `项目源码/server/src/app.js`、`authorization.js`、`assistant.js`、`auth.js`、`db.js` 与 `index.js` 核对，2026-09-23 更新。显式注册了 20 个 API 路由。本文是运行行为说明，不代表 GitHub Actions、真实模型或 109 条 RTM 已全部验收。
>
> [API 基线快照](API当前基线.md) 与 [开发基线快照](开发基线.md) 仅记录旧 `67813a1`；不要用其中的路由数量、权限或表结构描述当前实现。

## 1. 启动与环境变量

在 `项目源码/` 执行根工作区命令：`npm start` 只启动 API，`npm run dev` 启动 API 和 Vite。API 脚本属于 `server` workspace，运行时工作目录为 `项目源码/server/`；因此相对 `DB_PATH` 按该目录解析。例如 `DB_PATH=./data/community-v2.sqlite` 对应 `项目源码/server/data/community-v2.sqlite`。`.env.example` 不会自动加载，变量须由 shell、进程管理器或 CI 显式提供。直接从其他目录运行 Node 时，相对路径会按那个进程工作目录解析。

| 变量 | 默认值 | 行为 |
| --- | --- | --- |
| `PORT` | `3020` | API 监听端口。 |
| `DB_PATH` | `项目源码/server/data/community-v2.sqlite` | 未设置时由 `db.js` 相对源码位置选择该 SQLite 文件。自定义相对路径按 API 进程工作目录解析；启动时会创建其父目录。也可设为 `:memory:`。 |
| `AUTH_SECRET` | `change-this-secret-before-production` | 用于 HMAC-SHA256 Bearer 令牌。部署前必须设为随机强密钥。 |
| `LLM_BASE_URL` | 空 | OpenAI-compatible API 基地址；若已包含 `/chat/completions` 则直接使用，否则追加该路径。 |
| `LLM_API_KEY` | 空 | 与 `LLM_BASE_URL` 同时设置时才尝试调用模型。 |
| `LLM_MODEL` | `gpt-4o-mini` | 发给模型服务的模型名称。 |
| `LLM_TIMEOUT_MS` | `20000` | 模型请求超时毫秒数。只接受正数，最大按 `120000` 计算；缺失、无效或非正数使用默认值。 |
| `ASSISTANT_SESSION_TTL_MS` | `28800000` | 新助手会话有效期毫秒数，默认 8 小时。只接受正数，最大按 `604800000`（7 天）计算；缺失、无效或非正数使用默认值。 |

两个助手参数在 API 模块启动时读取，修改后需重启 API。`GET /api/assistant/status` 的 `live` 表示 URL 与 key 已配置，不代表对模型服务的连通性检查；真实请求失败或超时时会使用安全引导回复。空配置时不会调用外部模型。

## 2. 通用行为与身份边界

- API 前缀为 `/api`，请求体按 JSON 解析，限制为 256 KB；CORS 配置允许请求来源。
- 登录成功返回 HMAC Bearer 令牌。令牌有效期 8 小时；每个受保护请求会按令牌中的用户 ID 重新读取账号，并要求账号仍为 active。受保护请求使用 `Authorization: Bearer <token>`。
- 登录角色为 `guest`、`staff`、`dean`。助手还接受 `public`，但它仅表示未登录的公开助手，不是登录账号角色。
- `staffOnly` 路由允许工作人员和院长；`deanOnly` 路由只允许院长。角色通过后仍执行对应的客人资源授权。
- 工作人员只能访问当前有效分工范围内的 active 客人：分工必须为 active、开始时间不晚于当前时间，且结束时间为空或晚于当前时间。院长可访问全部 active 客人；客人只能访问本人。
- API 错误通常为 JSON `{ "error": "说明", "code": "ERROR_CODE" }`，部分错误另含 `details`。未捕获的服务器异常返回通用 `INTERNAL_ERROR`。错误码列表见下文。

## 3. 路由

`公开` 表示不需要登录；`可选 Bearer` 表示允许匿名请求，但若提供凭证会校验并使用登录身份；其余路由需要有效 Bearer 令牌。

| # | 方法与路径 | 权限 | 行为与主要输入 |
| ---: | --- | --- | --- |
| 1 | `GET /api/health` | 公开 | 返回 `{ok,service,time}` 健康状态。 |
| 2 | `GET /api/news` | 公开 | 返回新闻列表，置顶及发布时间排序。 |
| 3 | `GET /api/news/:id` | 公开 | 返回一条新闻；不存在时报 `NEWS_NOT_FOUND`。 |
| 4 | `GET /api/assistant/status` | 公开 | 返回模型配置状态、模型名、超时值和安全引导模式信息；不验证模型连通性。 |
| 5 | `POST /api/assistant/chat` | 可选 Bearer | JSON `{role?,text,sessionId?,guestId?}`；文本必填且最多 4000 字符。服务器创建或校验助手会话，返回 `sessionId`、回复、快捷问题、`live` 和 `mode`。 |
| 6 | `GET /api/assistant/history` | 可选 Bearer | 需要 `?sessionId=<id>`，可带 `role`、`guestId`；只返回已授权会话的消息。 |
| 7 | `POST /api/auth/login` | 公开 | JSON `{username,password,role}`；成功返回 `{token,user}`。账号、密码或角色不匹配时报 `AUTH_INVALID_CREDENTIALS`。 |
| 8 | `GET /api/me` | Bearer | 客人返回本人概览；工作人员/院长返回安全用户信息及 `assignedCount`。 |
| 9 | `PATCH /api/me/profile` | Bearer；仅客人 | 仅接受 `phone`（最多 32 字符）、`emergencyContact` 与 `mobility`（各最多 128 字符）；拒绝未列字段并原子更新。 |
| 10 | `POST /api/me/password` | Bearer | JSON `{currentPassword,newPassword}`；新密码长度 8–128 字符。 |
| 11 | `GET /api/me/health` | Bearer | 客人读取本人记录；工作人员须有该客人有效分工；院长可读 active 客人。工作人员/院长使用 `?guestId=<id>` 指定客人。 |
| 12 | `GET /api/me/advice` | Bearer | 与健康记录使用相同的客人范围规则，仅返回对该客人生效的医嘱/建议及作者信息。 |
| 13 | `GET /api/agent/status` | Bearer | 返回规则协作 Agent 状态。可选 `guestId`；传入时按上述客人授权检查。该路由返回状态，不执行疗程或预约工具。 |
| 14 | `GET /api/staff/overview` | 工作人员或院长 | 返回可访问客人数量、有效建议数及近期审计记录；工作人员结果按其授权范围筛选，院长使用院长视野。 |
| 15 | `GET /api/dean/staff` | 仅院长 | 返回工作人员列表及查看/建议计数。 |
| 16 | `GET /api/dean/staff/:id/logs` | 仅院长 | 返回工作人员资料、按时间倒序排列的最近最多 50 条审计记录和该院长自己的历史意见。 |
| 17 | `POST /api/dean/staff/:id/reviews` | 仅院长 | JSON `{content}`；非空且最多 5000 字符，成功返回 201 并记录意见。 |
| 18 | `GET /api/staff/guests` | 工作人员或院长 | 可带 `?q=<姓名或房间>`；工作人员结果限于有效分工，院长可查看全部 active 客人。 |
| 19 | `GET /api/staff/guests/:id` | 工作人员或院长 | 返回客人概览并写入查看审计；工作人员需有有效分工。 |
| 20 | `POST /api/staff/guests/:id/advice` | 工作人员或院长 | JSON `{title,content,priority?}`；标题最多 200 字符，内容最多 5000 字符，priority 为 `normal`、`important` 或 `urgent`；需通过客人授权。成功返回 201。 |

## 4. 分工、助手会话与数据表

- SQLite schema 包含 `staff_guest_assignments`、`assistant_sessions`、`assistant_messages` 和 `health_intakes` 等表。新演示库在首次 seed 时建立演示分工；旧库首次引入分工表时仅迁移一次。`health_intakes.status` 默认为 `pending`，既有采集记录升级后也补为 `pending`；当前没有采集审核 API。分工行删除后，后续启动不会自动恢复。当前没有创建、编辑或删除分工的 HTTP API。
- 助手会话 ID 由服务端生成，关联用户、助手角色及可选客人上下文，并记录 active/closed/expired 状态和到期时间。继续会话时检查用户、角色、会话状态、到期时间与客人上下文；不匹配会返回 403 或 409。
- 聊天消息保存在 `assistant_messages`。客人输入命中健康信息关键词时，当前实现还会将文本写入 `health_intakes`（`status='pending'`）并记录审计，但没有配套的审核管理 API，因此不等同于完成健康采集审核闭环。
- 发给外部模型的客人上下文有意排除姓名、电话、房间号、出生日期和紧急联系人；是否启用外部模型取决于 `LLM_BASE_URL` 与 `LLM_API_KEY`。

## 5. 主要结构化错误码

以下代码由当前路由和授权逻辑产生；各错误的 HTTP 状态与中文说明由具体请求场景决定。

| 类别 | 错误码 |
| --- | --- |
| 鉴权/角色 | `AUTH_REQUIRED`、`AUTH_INVALID`、`AUTH_INVALID_CREDENTIALS`、`ACCOUNT_INACTIVE`、`ROLE_FORBIDDEN` |
| 客人授权 | `GUEST_ID_REQUIRED`、`GUEST_ID_INVALID`、`GUEST_NOT_FOUND`、`GUEST_INACTIVE`、`GUEST_FORBIDDEN`、`GUEST_NOT_ASSIGNED` |
| 资料/密码 | `PROFILE_GUEST_ONLY`、`PROFILE_INVALID_BODY`、`PROFILE_FIELD_NOT_ALLOWED`、`PROFILE_NO_FIELDS`、`PROFILE_FIELD_INVALID`、`PROFILE_NOT_READY`、`PASSWORD_CURRENT_INVALID`、`PASSWORD_NEW_INVALID` |
| 新闻/工作人员/意见/建议 | `NEWS_NOT_FOUND`、`STAFF_NOT_FOUND`、`REVIEW_INVALID`、`ADVICE_INVALID` |
| 助手角色/文本 | `ASSISTANT_ROLE_INVALID`、`ASSISTANT_ROLE_FORBIDDEN`、`ASSISTANT_TEXT_INVALID`、`ASSISTANT_TEXT_REQUIRED`、`ASSISTANT_TEXT_TOO_LONG` |
| 助手会话 | `ASSISTANT_SESSION_REQUIRED`、`ASSISTANT_SESSION_NOT_FOUND`、`ASSISTANT_SESSION_FORBIDDEN`、`ASSISTANT_SESSION_INACTIVE`、`ASSISTANT_GUEST_CONTEXT_MISMATCH` |
| 请求/服务器 | `INVALID_JSON`、`INTERNAL_ERROR` |

这份契约仅记录当前实现边界，不证明未运行的外部服务、GitHub Actions 或 RTM 项已通过验收。MySQL 应用层迁移、分工管理 API、健康采集审核以及疗程/预约等业务仍需单独开发与验收。
