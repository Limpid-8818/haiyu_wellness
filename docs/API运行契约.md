# 现行 API 与运行契约

> 本文依据截至 2026-10-11 的当前 `项目源码/server/src` 实现，覆盖 123 个 API 路由、SQLite/MySQL v25 和 48 张业务表。阶段27-R1–R4已由源Sol独立通过业务和资源双门（保留已批准的历史例外）；R5中源Sol已实际独立通过Q27.7，执行任务Q27.8仍FAIL。Q27.6源端曾按用户选定的Open-Meteo默认模式完成一次有界24小时天气、海况及含潮汐模式海面高度实测，核验来源/网格/时间及API、缓存、数据库、页面共用快照；该记录不表示持续连通或当前持续新鲜度，也不代表官方站点读数、机构安全阈值或生产服务。该默认模式不需要QWeather潮汐站凭据。R5与阶段27仍未最终验收；逐项状态及资源依据见[第38轮报告](../wangshanchong/第38轮报告.md)、[源端R5复核](阶段27R5首次源独立复核_20261011.md)。本契约说明当前代码与运行边界，不代表生产迁移、真实模型服务或109项RTM全部通过。
>
> 2026-10-11 R5启动地址修复后，Vite dev/preview 默认绑定 `127.0.0.1` 并启用严格端口；本地受管暖启动的根页请求已返回HTTP 200，Q27.8完整冷安装、四角色和备份恢复仍待源Sol使用已批准的一次额外冷安装独立复验，阶段状态仍为FAIL。
>
> [API 基线快照](API当前基线.md) 与 [开发基线快照](开发基线.md) 仅记录旧 `67813a1`；不要用其中的路由数量、权限或表结构描述当前实现。

## 1. 启动与环境变量

在 `项目源码/` 执行根工作区命令：`npm start` 只启动 API，`npm run dev` 启动 API 和 Vite。运行要求为 Node.js `>=22.13.0`、npm `>=10`；Node 22.13.0 起可直接使用内置 `node:sqlite`，无需实验标志。API 脚本属于 `server` workspace，会读取 `项目源码/.env`；shell、进程管理器或 CI 显式提供的变量优先。Vite 仅读取该文件中的 `WEB_PORT` 与 `API_PROXY_TARGET`。`.env.example` 是示例文件，不会自动加载。API 运行时工作目录为 `项目源码/server/`；因此相对 `DB_PATH` 按该目录解析。例如 `DB_PATH=./data/community-v2.sqlite` 对应 `项目源码/server/data/community-v2.sqlite`。直接从其他目录运行 Node 时，相对路径会按那个进程工作目录解析，且不会自动读取 `.env`。

Vite dev 默认监听 `127.0.0.1:5180`，preview 默认监听 `127.0.0.1:5181`；设置 `WEB_PORT` 后两者分别使用该端口和其后一端口。端口被占用时启动会失败，不会静默改用其他端口。浏览器打开前端时使用 `http://127.0.0.1:<WEB_PORT>/`，使验收地址与实际监听接口一致。

| 变量 | 默认值 | 行为 |
| --- | --- | --- |
| `DB_DRIVER` | `sqlite` | 显式选择 `sqlite` 或 `mysql`。MySQL 连接失败会启动失败，不会静默切到 SQLite。 |
| `PORT` | `3020` | API 监听端口。 |
| `DB_PATH` | `项目源码/server/data/community-v2.sqlite` | 仅 SQLite 使用。未设置时由 `db.js` 相对源码位置选择该文件。自定义相对路径按 API 进程工作目录解析；启动时会创建其父目录。也可设为 `:memory:`。 |
| `MYSQL_HOST` | `127.0.0.1` | MySQL 主机；stage10 集成关卡限制使用回环地址。 |
| `MYSQL_PORT` | 无 | 使用 MySQL 时必填端口。 |
| `MYSQL_USER` | 无 | 使用 MySQL 时必填账号。 |
| `MYSQL_PASSWORD` | 空 | MySQL 密码；留在本机环境配置，不提交仓库。 |
| `MYSQL_DATABASE` | 无 | 使用 MySQL 时必填；目标数据库需预先创建。 |
| `MYSQL_POOL_SIZE` | `10` | MySQL 连接池大小，限制在 1–20。 |
| `DEMO_SEED` | `0` | 只有显式设为 `1` 且 `users` 为空时尝试插入演示数据；与版本迁移分开。 |
| `AUTH_SECRET` | `change-this-secret-before-production` | 用于 HMAC-SHA256 Bearer 令牌。部署前必须设为随机强密钥。 |
| `LLM_BASE_URL` | 空 | OpenAI-compatible API 基地址；若已包含 `/chat/completions` 则直接使用，否则追加该路径。 |
| `LLM_API_KEY` | 空 | 与 `LLM_BASE_URL` 同时设置时才尝试调用模型。 |
| `LLM_MODEL` | `gpt-4o-mini` | 发给模型服务的模型名称。 |
| `LLM_TIMEOUT_MS` | `20000` | 模型请求超时毫秒数。只接受正数，最大按 `120000` 计算；缺失、无效或非正数使用默认值。 |
| `ASSISTANT_SESSION_TTL_MS` | `28800000` | 新助手会话有效期毫秒数，默认 8 小时。只接受正数，最大按 `604800000`（7 天）计算；缺失、无效或非正数使用默认值。 |
| `ENVIRONMENT_MODE` | unavailable | 可设为 `demo` 使用显式标记的合成夹具；`live` 只在同时设置 `ENVIRONMENT_LIVE=1` 时启用；其他情况不调用提供方。 |
| `ENVIRONMENT_LIVE` | `0` / 未设置 | 真实环境请求的显式二次开关；必须为 `1` 且 `ENVIRONMENT_MODE=live`。 |
| `ENVIRONMENT_LOCATION_ID` / `ENVIRONMENT_LOCATION_NAME` | 无 | 机构确认的地点标识与显示名称；不使用推测地点。 |
| `ENVIRONMENT_LATITUDE` / `ENVIRONMENT_LONGITUDE` | 无 | 机构确认的经纬度，纬度范围 -90…90、经度 -180…180。测试夹具的 0,0 只用于本地，不是机构地址。 |
| `ENVIRONMENT_TIME_ZONE` | 无 | 机构确认的 IANA 时区。当前本地 demo 使用 `Asia/Shanghai`。 |
| `QWEATHER_TIDE_STATION_ID` | 无 | 仅选择 QWeather 台站潮汐适配器时使用与地点匹配的 LocationID；缺失时不发送该适配器的站点请求。Open-Meteo 默认模式使用模式海面高度，不需要该站点ID。 |
| `QWEATHER_API_HOST` | 无 | 当前 QWeather 账号专属 API Host；不使用旧共享 host。 |
| `QWEATHER_API_KEY` | 无 | QWeather key，仅由服务器作为 `X-QW-Api-Key` 请求头使用；不会出现在 API 响应或日志。 |
| `OPEN_METEO_WEATHER_BASE_URL` / `OPEN_METEO_MARINE_BASE_URL` | 官方公开 API | 可选获准网关 endpoint；默认使用 Open-Meteo Forecast 与 Marine API。 |

两个助手参数在 API 模块启动时读取，修改后需重启 API。`GET /api/assistant/status` 的 `live` 表示 URL 与 key 已配置，不代表对模型服务的连通性检查；真实请求失败或超时时会使用安全引导回复。空配置时不会调用外部模型。环境适配配置由 API 模块启动进程读取；默认 `ENVIRONMENT_MODE=unavailable`，不联网，需显式启用获准的提供方模式。源端Q27.6记录的是一次已完成的有界Open-Meteo实测及当时快照一致性，不代表当前持续连通/新鲜度。用户选定的Open-Meteo默认模式不要求QWeather密钥或站点ID；如另选QWeather台站模式，才使用相应QWeather凭据。数据边界、缓存与凭证步骤见[环境服务接入卡](环境服务接入卡.md)。

## 2. 通用行为与身份边界

- API 前缀为 `/api`，请求体按 JSON 解析，限制为 256 KB；CORS 配置允许请求来源。
- 登录成功返回 HMAC Bearer 令牌。令牌有效期 8 小时；每个受保护请求会按令牌中的用户 ID 重新读取账号，并要求账号仍为 active。受保护请求使用 `Authorization: Bearer <token>`。
- 登录角色为 `guest`、`staff`、`dean`。`staff` 账号按岗位字段 `jobType` 区分 `clinician`、`administrator`、`coach`、`therapist`、`dietitian`；旧工作人员记录缺少岗位时按医护兼容。助手还接受 `public`，但它仅表示未登录的公开助手，不是登录账号角色。
- `staffOnly` 路由允许工作人员和院长；`staffManagementOnly` 路由允许院长或管理员岗位；`deanOnly` 路由只允许院长。医护建议发布只授予医护岗位，不能由通用岗位开关授予。角色通过后仍执行对应的客人资源授权。
- `GET /api/staff/overview` 还会检查 `operations.summary.view` 岗位能力；能力关闭时接口返回 403，前端同时隐藏对应入口。
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
| 5 | `POST /api/assistant/chat` | 可选 Bearer | JSON `{role?,text,sessionId?,guestId?,async?,clientRequestId?}`，也可用 `Idempotency-Key`；文本必填且最多 4000 字符。同步模式返回回复与会话；`async:true` 返回 202、`runId`、`sessionId`、状态及重复请求标记，随后通过运行查询读取结果。 |
| 6 | `GET /api/assistant/history` | 可选 Bearer | 需要 `?sessionId=<id>`，可带 `role`、`guestId`；只返回已授权会话的消息。 |
| 7 | `POST /api/auth/register` | 公开 | JSON `{name?,phone,password,confirmPassword}`；手机号为中国大陆 11 位手机号，成功返回 201、登录令牌及 `admissionStatus: pending`，手机号同时作为账号。不会发送验证码或办理入住。 |
| 8 | `POST /api/auth/login` | 公开 | JSON `{username,password,role}`；成功返回 `{token,user}`，用户数据含岗位能力。账号、密码或角色不匹配时报 `AUTH_INVALID_CREDENTIALS`。 |
| 9 | `GET /api/me` | Bearer | 客人返回本人概览、入住状态与档案；工作人员/院长返回安全用户信息、岗位能力及 `assignedCount`。 |
| 10 | `GET /api/me/capabilities` | Bearer | 返回岗位、岗位名称、员工管理权、运营汇总查看权及医护建议发布权。 |
| 11 | `PATCH /api/me/profile` | Bearer；仅客人 | 仅接受 `phone`（最多 32 字符）、`emergencyContact` 与 `mobility`（各最多 128 字符）；拒绝未列字段并原子更新。 |
| 12 | `POST /api/me/password` | Bearer | JSON `{currentPassword,newPassword}`；新密码长度 8–128 字符。 |
| 13 | `GET /api/me/health` | Bearer | 客人读取本人记录；工作人员须有该客人有效分工；院长可读 active 客人。工作人员/院长使用 `?guestId=<id>` 指定客人。 |
| 14 | `GET /api/me/health-profile` | Bearer；仅客人 | 返回结构化正式档案、自述草稿、版本、8 项完整度、待核实记录、只读历史和有效过敏/忌口约束。 |
| 15 | `POST /api/me/health-intakes` | Bearer；仅客人 | JSON `{profile,baseProfileVersion}`；严格校验慢病、用药原文与时段、过敏、忌口、行动、睡眠、皮肤、客群标签；保存为 `source=form` 的 pending 版本，不覆盖正式档案。相同内容去重返回 200，新版本返回 201；版本过期返回 409。 |
| 16 | `GET /api/me/advice` | Bearer | 与健康记录使用相同的客人范围规则，仅返回对该客人生效的医嘱/建议及作者信息。 |
| 17 | `GET /api/agent/status` | Bearer | 返回规则协作 Agent 状态。可选 `guestId`；传入时按上述客人授权检查。该路由返回状态，不执行疗程或预约工具。 |
| 18 | `GET /api/staff/overview` | 工作人员或院长 | 返回可访问客人数量、有效建议数及近期审计记录；工作人员结果按授权范围筛选并需有运营汇总能力，院长使用院长视野。 |
| 19 | `GET /api/dean/staff` | 院长或管理员岗位 | 返回工作人员列表及查看/建议计数。 |
| 20 | `POST /api/dean/staff` | 院长或管理员岗位 | JSON `{name,username,phone?,password,jobType}`；创建员工并返回 201。账号重复报 409。岗位为五种受支持 `jobType` 之一。 |
| 21 | `PATCH /api/dean/staff/:id` | 院长或管理员岗位 | JSON `{status?,jobType?}`；状态为 `active`/`disabled`。当前操作者不能停用自己或移除自己的管理员岗位；历史工作记录保留。 |
| 22 | `GET /api/dean/job-capabilities` | 院长或管理员岗位 | 返回岗位列表、能力定义和矩阵；医护建议发布权固定，运营汇总查看权可调整。 |
| 23 | `PATCH /api/dean/job-capabilities` | 院长或管理员岗位 | JSON `{jobType,capability,enabled}`；当前只允许更改 `operations.summary.view`；尝试修改 `medical_advice.publish` 返回 400。 |
| 24 | `GET /api/dean/guests` | 院长或管理员岗位 | 可带 `?status=pending\|in_house\|checked_out` 与 `?q=<姓名、电话或房间>`；返回客人入住字段和派生状态。 |
| 25 | `PATCH /api/dean/guests/:id/stay` | 院长或管理员岗位 | JSON `{roomNo,checkIn,checkOut,stayPlan}`；实际住宿区间按离店日期减入住日期计算，`three_night` 最多登记 3 晚，`ten_night` 最多登记 10 晚。疗程日程上限（3 天/7 天）属于后续 Q21.5，Stage 11 此接口不生成疗程；成功后客人 `/api/me` 同步实际日期、入住类别和状态。 |
| 26 | `GET /api/dean/guests/:id/assignments` | 院长或管理员岗位 | 返回该客人的有效与已结束负责关系、岗位和生效区间。 |
| 27 | `POST /api/dean/guests/:id/assignments` | 院长或管理员岗位 | JSON `{staffId}`；为 active 员工创建负责关系并返回 201；重复有效关系返回 409。 |
| 28 | `PATCH /api/dean/guests/:guestId/assignments/:assignmentId` | 院长或管理员岗位 | 结束对应负责关系，写入 `endAt` 与审计记录；关系保留在历史列表。 |
| 29 | `GET /api/dean/staff/:id/logs` | 仅院长 | 返回工作人员资料、按时间倒序排列的最近最多 50 条审计记录和该院长自己的历史意见。 |
| 30 | `POST /api/dean/staff/:id/reviews` | 仅院长 | JSON `{content}`；非空且最多 5000 字符，成功返回 201 并记录意见。 |
| 31 | `GET /api/staff/guests` | 工作人员或院长 | 可带 `?q=<姓名或房间>`；工作人员结果限于有效分工，院长可查看全部 active 客人。 |
| 32 | `GET /api/staff/guests/:id` | 工作人员或院长 | 返回客人概览并写入查看审计；工作人员需有有效分工。 |
| 33 | `GET /api/staff/guests/:id/health-intakes` | 仅负责该客人的医护工作人员 | 返回正式档案、待核实采集、只读版本历史与有效健康约束；要求医护岗位和有效分工。 |
| 34 | `POST /api/staff/health-intakes/:id/confirm` | 仅负责该客人的医护工作人员 | 确认带结构化候选的 pending 采集；事务合并已回答字段、增加正式档案版本并记录核实前后快照、处理人和时间。重复确认幂等；过期基准版本返回 409。 |
| 35 | `POST /api/staff/health-intakes/:id/reject` | 仅负责该客人的医护工作人员 | JSON `{reason}`，原因必填且最多 1000 字；保留原始文本/结构化候选及原因，不修改正式档案。 |
| 36 | `POST /api/staff/guests/:id/advice` | 仅医护工作人员 | JSON `{title,content,priority?}`；标题最多 200 字符，内容最多 5000 字符，priority 为 `normal`、`important` 或 `urgent`；需通过客人授权。成功返回 201。 |
| 37 | `GET /api/projects` | 公开 | 支持 `?category=` 的 `water_therapy`、`exercise`、`seaside` 分类和 `?q=<关键词>`；默认只返回启用项目，空结果为 `{items:[],total:0}`。目录数据的地点、开放窗口和容量均标记为演示值。 |
| 38 | `GET /api/projects/:id` | 公开 | 返回启用项目的完整详情；不存在或停用项目返回 `PROJECT_NOT_FOUND`。 |
| 39 | `GET /api/admin/projects` | 院长或管理员岗位 | 返回所有项目（包括停用项），用于后台维护。 |
| 40 | `PATCH /api/admin/projects/:id` | 院长或管理员岗位 | 仅可改介绍、适宜人群、禁忌、开放窗口、演示时段容量和 active；时间需为严格递增的 `HH:MM`；不提供物理删除。调整开放窗口后，旧时段保留但不再可预约；已有预约与历史记录保留，不批量取消。 |
| 41 | `GET /api/knowledge` | 公开 | 支持 `?domain=` 的 `therapy`、`nutrition`、`exercise`、`companionship` 领域及 `?q=<关键词>`；仅返回启用条目，并带来源链接、来源核对时间和更新时间。 |
| 42 | `GET /api/rules` | 公开 | 支持 `?q=<关键词>`；返回启用规则的编号、版本、触发条件、动作、来源和演示说明。 |
| 43 | `GET /api/environment` | 仅客人 | 可选 `?date=YYYY-MM-DD&projectId=<启用项目ID>`；返回同一地点/日期的 `snapshotId`、来源、逐时天气/潮汐/海况、有效期、freshness、缺失配置、演示限制和可选时段核对。项目参数只读，不创建预约或扣减容量。默认 unavailable；demo 数据明确标记；室内项目不依赖环境域，陆上户外只核对天气/UV，下海项目核对天气/UV、潮汐和海浪；所需域缺失/过期保持 pending。live 原始 UV 不套用 demo 分类，机构安全阈值未获确认时仍为 pending。 |
| 44 | `POST /api/rules/evaluate` | 客人本人、院长、或有有效分工的医护工作人员 | JSON `{projectId,guestId?,environment?}`；客人只能核对本人，医护需满足客人资源授权。只接受 `uvLevel`、`seaStatus`、`source` 环境输入。返回 R1–R5 判定、来源和审核标记；不调用模型，不放行缺少或不安全海况数据的下海项目。 |
| 45 | `GET /api/projects/:id/slots` | 仅客人 | 可选 `?date=YYYY-MM-DD`，限今天起 7 天；返回服务端排期、容量、已约数、余量、状态与不可预约原因。按最新项目开放窗口重算状态；窗口变更后旧 slot 标为 `window_changed` 且不可选择。 |
| 46 | `POST /api/reservations` | 客人本人 | JSON `{slotId}`，并须提供 `Idempotency-Key` 请求头；事务内复核开放窗口、入住日期、环境/健康规则、时段、容量与重叠预约。新预约返回 201，幂等重放返回 200；不接受客人 ID 或额外字段。 |
| 47 | `GET /api/reservations` | 客人本人 | 返回本人有效预约及已取消历史；支持客户端按 `businessDate` 筛选，不删除历史。 |
| 48 | `DELETE /api/reservations/:id` | 客人本人 | 取消本人尚未开始的预约，保留取消原因与历史并释放一个名额；重复取消保持幂等，不可取消已开始或结束时段。 |
| 49 | `GET /api/schedule` | 本人、院长或有权访问该客人的工作人员 | 可选 `?guestId=<id>`；沿用客人资源授权，返回仍有效的预约日程投影；取消记录不显示在有效日程中。 |
| 50 | `GET /api/admin/projects/:id/slots` | 院长或管理员岗位 | 可选 `?date=YYYY-MM-DD`，限今天起 7 天；返回单个项目日期排期、容量、关闭状态、有效预约数及当前窗口匹配状态。 |
| 51 | `PATCH /api/admin/projects/:id/slots/:slotId` | 院长或管理员岗位 | JSON 仅接受 `{capacity?:1..100,closed?:boolean}`；容量不能低于有效预约数。关闭或调高容量不取消既有预约；窗口已变更的旧 slot 不可重新开放成可预约项。 |
| 52 | `GET /api/meals/dishes` | 客人本人 | 返回菜品编号、明确配料/过敏原/餐次/餐位、演示营养标签、来源、供应状态和非海鲜替代项；不从菜名推断过敏原。 |
| 53 | `GET /api/meals/menu` | 客人本人 | 可带 `?date=YYYY-MM-DD`；只读本人该上海业务日期已保存餐单。没有餐单时返回 `needs_generation`，不复制其他日期；日期必须在登记入住区间内。 |
| 54 | `POST /api/meals/menus` | 客人本人 | JSON `{businessDate}`；根据当前正式、待核实及旧档案明确限制筛选并保存当天三餐、三个餐位、版本、规则依据与避开项。重复生成返回同一菜单；菜品不足保留空餐位及具体原因，不放宽限制或预留库存。 |
| 55 | `PATCH /api/meals/menus/:menuId/items/:itemId` | 菜单所属客人 | JSON `{version,dishId,reason}`；要求原因，按当前健康限制和演示供应状态复核；只替换一个餐位并递增版本。若该餐次订单仍为 reserved，同事务更新订单菜品快照；preparing/delivered 返回 409 并提示联系配餐员。 |
| 56 | `GET /api/meals/orders` | 客人本人 | 可带 `?date=YYYY-MM-DD`；返回本人订单号、上海业务日期、餐次、菜品快照、状态、UTC 创建时刻和标为演示估算的 UTC 预计送餐时刻。 |
| 57 | `POST /api/meals/orders` | 客人本人 | JSON `{menuId,businessDate,mealType,version}` 且需提供 `Idempotency-Key`；仅从本人已保存且完整的餐次菜单创建订单。重复键同请求返回同单，复用键改请求返回 409；唯一约束与事务保证不同并发键不生成重复日期/餐次单。 |
| 58 | `GET /api/staff/meals/orders` | 仅配餐员岗位且当前有效分工 | 必须通过 dietitian 岗位校验；可带 `?date=YYYY-MM-DD&mealType=breakfast\|lunch\|dinner`。只返回授权客人的日期、餐次、姓名、房间、菜品和明确过敏/忌口，不返回完整健康档案。 |
| 59 | `PATCH /api/staff/meals/orders/:orderId/status` | 仅负责该客人的配餐员 | JSON `{status}`；仅允许 `reserved → preparing → delivered`；相同状态请求幂等，跳步或回退返回 409。每次使用当前读取锁定订单行。 |
| 60 | `GET /api/me/health-records` | Bearer；按客人资源范围授权 | 返回最近最多 200 条本人/获授权客人的健康记录，包含来源、记录人和软撤回审计字段；已撤回项仍可在历史列表中查看。 |
| 61 | `POST /api/me/health-records` | Bearer；仅客人 | JSON `{metric,value,unit,recordedAt,note?}`；`metric` 为 `blood_pressure`、`sleep`、`steps`、`weight`。血压值为 `{systolic,diastolic}`；其余为有限数字，步数必须为整数。严格校验单位、演示输入范围、时区时间和备注，成功返回 201；来源和记录人从令牌推导。 |
| 62 | `DELETE /api/me/health-records/:id` | Bearer；仅客人且本人记录 | JSON `{reason}`，原因必填且最多 500 字符。仅能撤回本人录入、上海业务日为今天的记录；以 `voided_at/voided_by/void_reason` 软撤回并写审计，隔日记录返回 409，不物理删除。 |
| 63 | `GET /api/me/health-trends` | Bearer；按客人资源范围授权 | 必填 `?metric=blood_pressure\|sleep\|steps\|weight&days=7\|30`。按上海业务日取最新的有效样本；血压以收缩压、舒张压两条数值序列返回，缺失日为 `null`，每个点保留来源记录 ID。 |
| 64 | `GET /api/me/health-summary` | Bearer；按客人资源范围授权 | 与趋势接口使用相同的 `metric` 和 `days`；至少 3 个不同业务日有有效样本才返回 `ready` 及变化描述，否则返回 `insufficient_data`。两种状态均附上海业务日窗口、缺失数、源记录 ID 和版本化演示规则；仅供只读参考。 |
| 65 | `GET /api/mood/resources` | 公开 | 返回四种本地放松资源的 ID、名称、时长、来源/授权说明及音频、封面 URL。 |
| 66 | `GET /api/mood/resources/:resourceId/audio` | 公开 | 返回对应 WAV 音频；支持浏览器 Range 分段读取和拖动进度；未知资源返回 `MOOD_RESOURCE_NOT_FOUND`。 |
| 67 | `GET /api/mood/resources/:resourceId/cover` | 公开 | 返回对应 SVG 封面；未知资源返回 `MOOD_RESOURCE_NOT_FOUND`。 |
| 68 | `GET /api/me/moods` | Bearer；仅读取当前身份关联的记录 | 返回当前身份的心情记录，含上海业务日期、分值、备注和记录 ID。 |
| 69 | `POST /api/me/moods` | Bearer；写入当前身份记录 | JSON `{score,note?}`；分值为 1–5，每个上海业务日仅一条；重复提交返回 409 与现有记录 ID。成功后检查持续低分关注规则。 |
| 70 | `PUT /api/me/moods/:id` | Bearer；仅当前身份且仅上海时间当天 | JSON `{score,note?}`；更新原记录 ID；旧日期不可编辑，返回 `MOOD_EDIT_WINDOW_CLOSED`。 |
| 71 | `GET /api/me/mood-trends` | Bearer；仅读取当前身份关联的记录 | 必须提供 `?days=7\|30`；返回逐日分值、备注、记录 ID；缺失日期为 `null`，不按低分处理。 |
| 72 | `GET /api/me/mood-focus-items` | Bearer；仅当前身份 | 返回从本人连续低分记录形成的待关注项及源记录 ID；恢复后状态更新为 `improved`。该演示规则只供人工关注，不构成诊断。 |
| 73 | `POST /api/me/mood-resources/:resourceId/usage` | Bearer；当前身份 | JSON `{eventId}`；资源使用事件按当前身份与事件 ID 幂等，重复请求不会增加次数。使用次数不代表心理改善。 |
| 74 | `GET /api/me/mood-summary` | Bearer；仅当前身份 | 返回只读近期心情、关注项、资源使用与样本充分性摘要，并说明解释边界。 |
| 75 | `GET /api/staff/guests/:guestId/mood-summary` | 工作人员或院长；按有效分工/院长范围授权 | 返回指定客人的只读年龄段、近期记录/资源和样本状态；工作人员限当前有效分工内客人，不返回与摘要无关的完整档案。 |
| 76 | `GET /api/assistant/runs/:runId` | Bearer；运行所属客人或有权工作人员 | 返回已授权助手运行的状态、父子运行、步骤与安全诊断；不返回隐藏推理内容。 |
| 77 | `POST /api/assistant/runs/:runId/retry` | Bearer；运行所属客人或有权工作人员 | 重试失败或可重试运行；服务端重新检查会话/客人授权与幂等边界，返回新的运行状态。 |
| 78 | `POST /api/assistant/actions/:actionId/confirm` | Bearer；仅客人本人 | JSON `{sessionId,version}`，并提供匹配该卡片版本的 `Idempotency-Key`；服务端复查本人、会话、卡片时效和当前业务依据，再调用既有预约、点餐、换菜、指标或疗程变更服务。返回持久化的确认卡及真实业务 ID/状态；陈旧或失败的卡如实标记，不返回虚构成功。 |

Stage23 预约提案契约：正常结构化路径中，客人明确提出预约后，模型完成项目及时段只读核实，再以 `propose_program_booking` 传递已明确的项目和日期；省略未知的 `slotId`，由服务端生成 `needs_input` 卡和复核后的可选项。若模型只完成恰好两项成功且参数/结果相互匹配的只读查询，用户明确表示尚未选择，并给出有效项目编号和日期，运行可记录 `awaiting_guest_slot_selection`（澄清失败计数为0），展示工具实际返回的选项，但不创建操作卡或预约。用户随后在同一会话明确选择唯一选项编号时，服务端调用共享提案校验重新核验并生成 `pending_confirmation` 卡；该服务端处理不伪记为模型工具调用。两条路径都不得自动选择或确认；只有客人随后调用确认接口后才写入预约。除此条件以外，没有动作卡且未形成可验证缺项补问的预约意图仍计入真实理解失败。

助手运行及步骤的 `durationMs` 使用单调时钟测量实际运行时间，上海业务时间戳和固定验收业务日仍使用业务时钟。协作父运行的时长包含其执行过程；子运行和模型/工具步骤分别报告自己的耗时，不把并发父子耗时相加作为总时长。

Q23.2首轮 `needs_input` 卡断言失败时，先追加受限的 `OBSERVED` 运行收据，再追加带会话/运行摘要、实际单调 `elapsedMs`、用量、业务表前后计数、已到达步骤和待执行步骤的失败收据，并通过偏移量与SHA-256关联前一条观察。离线故障注入验证同一断言失败路径和有界回读；预期注入的外层验证行仍标记 `PASS`，嵌套失败摘要保留 `FAIL`。

| 79 | `GET /api/me/health-assessment` | Bearer；仅客人 | 返回 8 项健康初评的已答/待补状态、`version`、百分比和下一项；从既有正式字段种子开始，不把未回答当作正常。 |
| 80 | `PUT /api/me/health-assessment/answers` | Bearer；仅客人 | JSON `{field,answer,baseVersion?,sessionId?}`；字段和值按固定结构校验，版本冲突返回 409；成功递增初评版本并保留来源会话。 |
| 81 | `GET /api/me/health-intake-extractions` | Bearer；仅客人 | 返回本人结构化口语提取草案、候选、逐字证据、来源会话、模型执行模式和成本字段；不直接改正式档案。 |
| 82 | `POST /api/me/health-intake-extractions` | Bearer；仅客人 | JSON `{utterance,sessionId?}`；正文最多 256 KB，候选必须通过字段/原文校验；新提取 201，重复指纹 200；含糊行动能力只返回事实追问。 |
| 83 | `POST /api/me/health-intake-extractions/:id/confirm` | Bearer；仅客人 | JSON `{decisions}`，逐候选只能确认/拒绝；确认项一次性写入 Stage12 pending 核实记录，拒绝项不写入，重复确认幂等；正式档案不被覆盖。 |
| 84 | `GET /api/me/therapy-drafts` | Bearer；仅客人 | 可选 `stayStart`/`stayEnd`（严格 `YYYY-MM-DD`）；返回最多 50 个版本化疗程草案，包含状态、版本、源运行、审核策略和条目。 |
| 85 | `POST /api/me/therapy-drafts` | Bearer；仅客人 | 需 `Idempotency-Key`（8–120 个安全字符）；按客人入住区间的离店排他边界生成最多 3 天/7 天草案，新版 201、幂等重放 200；只保存 `pending_review`，不预约、不点餐、不占容量。 |
| 86 | `GET /api/me/therapy-drafts/:id` | Bearer；仅客人 | 返回本人草案及全部条目；条目保留日期、时段、项目/餐次、状态、理由、规则/来源 ID、环境快照和证据。不存在时报 `WELLNESS_DRAFT_NOT_FOUND`。 |
| 87 | `GET /api/me/timeline` | Bearer；仅客人 | 返回仍有效的未来已确认预约、取消历史和待审草案摘要；取消预约不进入 `upcomingBookings`，待审草案不属于预约且不占容量。 |
| 88 | `GET /api/me/wellness-notifications` | Bearer；仅客人 | 返回本人最多 100 条站内通知，包括疗程纠正、每日简报、预约提醒与关怀信号；含来源/目标、已读时间和未读数，不发送外部消息。 |
| 89 | `GET /api/staff/therapy-drafts` | Bearer；仅医护岗位 | 可按 `status`、`guestId`、入住覆盖 `date`、`risk` 筛选审核队列，返回待审/完成计数、风险级别、摘要和详情 ID；员工其他岗位拒绝。 |
| 90 | `GET /api/staff/therapy-drafts/:id` | Bearer；有权医护 | 返回疗程条目、健康/规则/来源证据、审核线程历史和该版本关联的项目预约；`approvalAction` 依据本版对应的医护修订事件返回 `approved_after_revision` 或 `approved`，客人自行再生成及纠正版不算医护修订。 |
| 91 | `GET /api/staff/therapy-drafts/:id/alternatives` | Bearer；有权医护 | 需 `itemId`；列出入住区间内当前真实开放、容量及安全校验通过的替代项目时段，只读，不占位。 |
| 92 | `PUT /api/staff/therapy-drafts/:id/revisions` | Bearer；有权医护 | JSON `{version,reason,edits:[{itemId,slotId,title?,reason}]}` 与 `Idempotency-Key`；只允许基于最新待审版本修订真实活动时段，成功创建新待审版本。相同键/相同内容重放同一版本；同键不同内容返回 409。 |
| 93 | `POST /api/staff/therapy-drafts/:id/approve` | Bearer；有权医护 | JSON `{version}` 与 `Idempotency-Key`；锁定最新待审版本，在同一事务重新核验条目、健康/规则/环境、入住、时段和容量，并写入项目 `reservations` 与审核/审计事件。普通通过记为 `approved`；当前版本与操作者、来源版本均由不可变医护 `revision` 事件对应时记为 `approved_after_revision`，事件载荷链接修订事件、原因和前后版本。任一失败整体回滚；相同请求重放不重复预约或事件。 |
| 94 | `POST /api/staff/therapy-drafts/:id/return` | Bearer；有权医护 | JSON `{version,reason}` 与 `Idempotency-Key`；必须提供具体原因；标记该版退回并留审计，不取消其他既有预约。 |
| 95 | `POST /api/staff/therapy-drafts/:id/correction` | Bearer；有权医护 | JSON `{version,reason,edits}` 与 `Idempotency-Key`；仅纠正最新已激活版本。一个事务中仅补偿该疗程仍有效的旧项目预约、创建新版本并激活合法新时段；保留旧版、取消原因、审计与单条本地客人通知。相同键/相同内容重放结果；同键不同内容返回 409。 |
| 96 | `GET /api/staff/therapy-review-history` | Bearer；有权医护或管理员 | 可按 `guestId`、`action`、`from`、`to` 查询；`action` 支持 `revision`、`approved`、`approved_after_revision`、`returned`、`auto_activated`、`corrected`；历史只读，保留操作者、理由、前后版本及事件载荷。普通岗位拒绝。 |
| 97 | `GET /api/staff/therapy-review-attention` | Bearer；管理员 | 返回尚未关闭的重复退回关注项；医护和普通岗位拒绝。 |
| 98 | `GET /api/me/checkins` | Bearer；仅客人本人 | 返回本人真实预约签到和体验反馈记录，关联预约、签到、反馈修订及日期；未签到/未反馈状态不会伪造完成记录。 |
| 99 | `POST /api/me/reservations/:reservationId/checkin` | Bearer；仅客人本人 | 仅对本人已经开始的有效预约签到；预约/客人归属从数据库核验，重复请求返回原签到记录（200），首次创建返回 201。 |
| 100 | `POST /api/me/reservations/:reservationId/feedback` | Bearer；仅客人本人 | 需已签到的本人预约；JSON `{feeling,note?}`，`feeling` 为 `comfortable`、`general` 或 `uncomfortable`。每个签到一条反馈，重复请求返回原记录。 |
| 101 | `PUT /api/me/feedback/:id` | Bearer；仅反馈所属客人且同一上海业务日 | JSON `{feeling,note?}`；递增反馈修订并追加不可变版本。跨业务日返回冲突，拒绝请求不留下部分修订。 |
| 102 | `GET /api/me/replanning-events` | Bearer；仅客人本人 | 返回本人按时间排序的反馈、健康指标和心情来源事件，包含来源 ID/版本、状态及关联基线/候选疗程版本。 |
| 103 | `GET /api/me/replanning-events/:id` | Bearer；仅事件所属客人 | 返回来源快照、触发原因、状态和实际候选版本/差异；不能读取他人事件。 |
| 104 | `POST /api/me/replanning-events/:id/evaluate` | Bearer；仅事件所属客人 | 由现有疗程协调器评估尚未消费的实际来源版本，保存关联候选草案及运行/规则证据；按来源版本去重，只生成待审候选，不预约或占用容量。 |
| 105 | `POST /api/me/replanning-events/:id/auto-activate` | Bearer；仅事件所属客人 | 复用阶段22统一健康/规则/抽检/时段/容量事务；不符合严格低风险条件时保持待审且不写预约，失败不部分替换旧版。 |
| 106 | `GET /api/me/daily-brief?date=YYYY-MM-DD` | Bearer；仅客人 | 日期可省略（默认上海业务日）；返回本人已持久化简报及活动、餐食、医嘱、环境快照、关怀来源与缺项。当天 07:00 前为 `not_ready`（已有快照则返回 `ready`），未生成的其他日期返回 `not_generated`。 |
| 107 | `PATCH /api/me/wellness-notifications/:id/read` | Bearer；仅客人本人 | 将本人通知标为已读并返回更新项和未读数；不存在或不属于本人时返回 `NOTIFICATION_NOT_FOUND`。 |
| 108 | `GET /api/staff/care-follow-up-tasks` | Bearer；staff/dean，按当前可访问客人范围 | 返回当前登录员工负责范围内的未完成心情关怀和医护修订跟进项；仅根据既有分工授权，不作诊断。 |
| 109 | `GET /api/admin/operations/guests` | 院长或管理员岗位 | 可带 `q`（姓名/房间）和 `date`；返回匹配入住客人的必要身份、年龄、房间、入住/状态和风险摘要。 |
| 110 | `GET /api/admin/operations/guests/:guestId/health-history` | 院长或管理员岗位 | 返回指定客人最近健康历史；按工作人员业务需要最小化字段。 |
| 111 | `GET /api/staff/operations/guests/:guestId/health-history` | 仅有有效客人分工的医护 | 返回负责客人的只读健康历史；服务岗位被拒绝，响应不含与任务无关的完整档案。 |
| 112 | `GET /api/admin/operations/slots` | 院长或管理员岗位 | `date`、`days`（1–7）及可选 `projectId`；返回同源 slot 容量、有效预约、余量、关闭状态与当前环境快照来源。 |
| 113 | `GET /api/admin/operations/reservations` | 院长或管理员岗位 | 按日期/范围、项目和 active/all 状态读取真实预约；按日表和项目排期使用同一 reservation/slot 来源。 |
| 114 | `POST /api/admin/operations/reservations/:id/no-show` | 院长或管理员岗位 | 项目开始后登记未参加签到；预约仍保留容量占用，不将其伪作取消。 |
| 115 | `POST /api/admin/operations/weather-cancellations/preview` | 院长或管理员岗位 | JSON `{slotIds,snapshotKey}`；对所选时段使用同一来源天气快照预览受影响预约，不写数据。 |
| 116 | `POST /api/admin/operations/weather-cancellations` | 院长或管理员岗位 | JSON `{slotIds,snapshotKey,requestKey?,reason}`，也可用 `Idempotency-Key`；事务取消受影响预约并写批次、批次明细和幂等站内通知。 |
| 117 | `GET /api/reservations/:id/reschedule-candidates` | Bearer；预约所属客人或其授权员工 | 对天气取消预约按规则、环境及容量读取可行替代时段和拒绝原因；不创建订单。 |
| 118 | `POST /api/reservations/:id/reschedule` | Bearer；预约所属客人或其授权员工 | JSON `{slotId}` 并提供 `Idempotency-Key`；明确选择后重新检查容量和规则，原单/新单/关联及通知在事务内提交。 |
| 119 | `POST /api/admin/operations/slots/:slotId/assignments` | 院长或管理员岗位 | JSON `{staffId,jobType}`；仅分配 coach、therapist 或 dietitian 岗位，并按 `(slotId,jobType)` 防重复。 |
| 120 | `GET /api/staff/schedule` | 工作人员或院长 | `date` 默认为当前上海业务日；返回当前账号岗位任务及项目、客人/预约和时段，按岗位过滤必要信息。 |
| 121 | `GET /api/admin/operations/summary` | 院长或管理员岗位 | `date` 及可选 `detail=guests\|reservations\|pendingReviews`；计数和点击明细均读取真实业务行。 |
| 122 | `GET /api/admin/operations/incidents` | 院长或管理员岗位 | 返回按供应商和功能聚合的当前运营异常，含连续失败次数、首次/最近时间、影响摘要和恢复状态。 |
| 123 | `POST /api/admin/operations/incidents/close` | 院长或管理员岗位 | JSON `{supplier,feature}`；仅服务恢复后可关闭对应异常，并记录关闭人和时间。 |

路由核对结果：契约 123 条、源码 123 条；方法与路径集合完全一致，缺失 0、额外 0、重复 0。

### Stage25 每日简报、站内通知与生命周期调度

`GET /api/me/daily-brief` 只允许客人读取本人数据。`date` 必须是有效 `YYYY-MM-DD`，否则返回 `DAILY_BRIEF_DATE_INVALID`。上海当天 07:00 前不提前生成简报；当天已有保存快照时可返回该快照。07:00 后首次读取可以生成当天快照。简报只汇总数据库中已确认活动预约、已保存餐单/订单、当前有效医护建议、指定日期的天气/潮汐/海况快照、三日心情关注和医护修订来源；缺少项明确列出。演示环境和来源快照会保留其来源/演示状态，不表示实时天气或临床结论。

通知保存在 `wellness_local_notifications`，按客人、来源类型和来源 ID 做唯一约束；重复调度保持同一事件 ID。读取接口最多返回 100 条并带 `unreadCount`；已读接口只更新本人通知，资源归属不符时不泄露其他客人的记录。心情关注与医护修订只会在存在当前有效医护分工时形成对应跟进任务；`GET /api/staff/care-follow-up-tasks` 再按员工身份和可访问客人范围过滤。

调度器随 API 生命周期启动，启动后执行一次受管 tick，之后每 60 秒检查；到上海 07:00 后按客人逐个生成/更新当日简报并同步关怀来源。预约提醒只检查 `(tick 时刻, tick 时刻 + 15 分钟]` 的已确认预约；事件使用数据库唯一来源键去重。关闭 API 时停止定时器并等待当前 tick 收尾，不留下脱离 API 的 cron 或后台服务。网页 Notifications API 仅在客人明确点击后调用；浏览器权限被拒时保留站内通知，不宣称浏览器关闭后仍可推送，也不发送短信、邮件或外部通知。

### Stage26 机构运营、岗位日程与业务异常

迁移 v25 新增 8 张本地业务表：爽约签到、天气批次及明细、改约关联、员工时段分配、提供方事件、提供方连续状态和运营事项。客人/预约/疗程计数从业务表实时聚合；预约视图、容量与岗位任务共享 `activity_slots` 和 `reservations`。爽约只写签到状态，不释放容量。天气批量取消引用同一来源快照，并在一个事务内更新预约、批次、明细和站内通知；数据库失败会整体回滚。改约由客人或其授权员工显式选定候选后写入新单并关联原单。人员岗位只读完成任务所需资料，医护健康历史和发布权限仍受医护/有效分工限制。

模型提供方成功/失败通过实际模型适配器请求写入诊断记录；连续失败达到 `OPERATIONS_FAILURE_THRESHOLD`（默认 3）形成每个供应商/功能唯一的运营事项，单次失败只记事件。下一次成功标记恢复，管理员确认恢复后关闭事项。助手岗位工具 `search_staff_review_context` 仅供有负责关系的医护查询，`search_operations_capacity` 仅供管理员只读查询。医护助手回答可在网页转成可编辑草稿；只有显式提交既有医嘱发布接口才写入医嘱和站内通知，取消草稿不写数据库。模型验收使用本机录制协议夹具，不证明外部供应商可用。

## 4. 分工、助手会话与数据表

- SQLite/MySQL 当前有 48 张业务表：原有 23 张核心表、v12 的 3 张心情/资源表、v17 的 4 张健康初评/提取/疗程草案表、v18 的 3 张审核/关注/通知表、v21 的 `assistant_action_cards`、v23 的签到/反馈/反馈修订/重规划来源事件 4 张表、v24 的 `daily_briefs` 和 `care_follow_up_tasks` 2 张表，以及 v25 的爽约签到、天气批次/明细、改约关联、岗位时段分配、提供方事件/状态和运营异常 8 张表。通知复用 `wellness_local_notifications`。另有 v13 建立的 `agent_runs`、`agent_steps`、`tool_executions` 三张助手运行追踪表；它们与 `schema_migrations` 一样单独计数，不属于业务表。v19 增加审核重放索引，v20 扩展审核事件动作约束，v21 还为 `health_records` 添加来源会话关联，v22 为运行记录补充 `stop_reason`，v23 为心情记录增加修订号；这些不额外增加表。v10 菜品目录由目标迁移的显式演示种子提供；只读 SQLite 导入器实际导入 17 张客人/订单业务表（11 张基础表、2 张 Stage15 表和 4 张 Stage16 菜单/订单表），不导入目标端种子目录，也不导入助手运行或确认卡记录。订单业务日期为上海日期；创建和状态时刻为 UTC；菜品与订单保留来源、健康限制依据和餐品快照；心情按上海业务日唯一记录，资源播放事件按身份和事件 ID 幂等。
- MySQL 启动需要显式 `DB_DRIVER=mysql`、`MYSQL_PORT`、`MYSQL_USER` 和 `MYSQL_DATABASE`。启动时验证 `SELECT 1` 与 MySQL 8.x 版本，再建立连接池；API 关闭时结束连接池。服务不在连接失败时转写另一数据库。
- 演示种子与迁移分开，只有显式 `DEMO_SEED=1` 且用户表为空时才写入演示账号及样例。Stage 11 的 v4 迁移补上员工岗位、客人入住计划和 `job_capability_settings`，旧 `staff` 默认映射为 `clinician`。分工行结束后，后续启动不会自动恢复；Stage 11 已提供创建、结束和查询负责关系的 HTTP API。
- `health_intakes.status` 在 SQLite 逻辑接口中默认为 `pending`；MySQL 对应 `review_status`。v2 为旧行补默认审核状态，v3 增加 `session_id` 关联；v5 为旧行保留原文与 pending 状态，并建立按客人共享的修订号及表单指纹唯一约束。旧助手文本不会被自动转成已核实结构化资料。
- `GET /api/me/health-profile` 与 `POST /api/me/health-intakes` 仅供客人使用。正式结构化档案与表单自述候选分开保存；提交记录来源、提交人、时间、基准版本和前后值。过期版本返回 409，重复提交相同内容会去重。既有 `PATCH /api/me/profile` 白名单仍只包含 `phone`、`emergencyContact`、`mobility`。
- Stage17 的健康指标写入只允许客人本人；支持血压、睡眠、步数、体重并使用 `mmHg`、`h`、`步`、`kg` 固定单位。演示范围为血压收缩压 30–400、舒张压 20–300（且舒张压不高于收缩压）、睡眠 0–24 小时、步数 0–100000 整数、体重 0.1–500 kg；这些范围用于演示录入检查，不是医学判断。记录时间需带时区且不得超过当前时间 5 分钟，来源/记录人由登录身份生成。旧记录只在类型、单位和数值格式明确时转为结构化值；无法解析的原文保留并标记 `unparsed_legacy`，不会作为趋势或助手健康上下文中的有效样本。
- 指标历史列表保留撤回记录。客人仅能对本人录入且上海业务日期为当天的记录执行撤回，必须给出原因；服务写入撤回人、时间、原因与审计，不物理删除。趋势只使用有效结构化样本，每个上海业务日取时间最新的一条；缺失日不补零，血压拆成两条序列。摘要至少需要 3 个不同业务日的有效样本；所有离群提示都是版本化演示展示规则，不作诊断，不自动更改疗程或建议。
- 仅有有效分工的医护工作人员可读取指定客人的自述历史、确认结构化 pending 候选或填写原因驳回。确认在一个事务中检查正式档案基准版本、合并回答字段、增加档案版本并保存核实前后快照；过期候选拒绝合并。驳回保存审核人、时间、原因和提交候选，正式档案保持不变。院长和非医护岗位不能处理这些记录。旧文本采集可以查看或驳回，但没有结构化候选时不能直接确认。
- Stage21 健康初评保存在 `health_assessment_progress`，固定 8 个字段按 `version` 增量更新；关闭页面后只返回缺失字段。`baseVersion` 不匹配返回 409，助手会话必须属于当前客人且仍为 active。
- Stage21 口语提取保存在 `health_extraction_drafts`，候选必须逐字段、逐字 `evidenceText` 校验，响应保留 `sessionId`、`executionMode`、模型/Token/成本和时间。含糊行动能力（例如“腿不太方便”）只生成事实追问，不推断严重程度；本人逐项确认后仅写入 Stage12 的 pending 健康采集，正式档案版本不变。
- Stage21 生成过程把疗程草案保存于 `wellness_drafts` 与 `wellness_draft_items`，按入住 `[checkIn, checkOut)` 计算日期，3 晚最多生成 3 天，10 晚最多生成 7 天；版本号、`sourceRunId`、规则/来源/环境证据和 `pending_review` 状态持久化。生成过程不预约、不点餐、不占容量；仅 Stage22 医护批准或满足严格低风险自动激活门后，真实活动项目才经 Stage15 预约服务写入 `reservations`。
- Stage22 审核结果以 `review_status` 记录 `pending_review`、`active`、`auto_activated`、`returned`、`corrected`、`superseded`；`wellness_review_events` 追加审核/修订事件，`review_thread_id` 串联版本。普通医护批准事件记作 `approved`；仅当当前版本、修订操作者、直接来源版本与本版医护修订事件相符且非纠正时记作 `approved_after_revision`，并把修订事件 ID、修订原因和前后版本保存在批准事件中。自动激活和两类医护批准共用同一激活事务；每个活动条目最后选定的 `project_slot` 来源必须绑定到对应预约；多项任一项遇到状态、规则或容量冲突，预约、成功审核事件和预约审计一起回滚，草案保持待审。项目预约由 `reservations` 表示；没有额外项目订单表，也不扩展到支付或膳食订单。
- Stage24 将真实预约执行写入 `wellness_checkins`；本人只能在对应预约已开始后签到，`reservation_id` 唯一约束保证重复请求返回原签到。体验写入 `wellness_feedback`，并以 `wellness_feedback_revisions` 追加每次当天修订；上海业务日结束后拒绝更改。反馈、健康指标和心情按来源 ID 与来源版本写入唯一 `wellness_replan_events`，并保存有界来源快照、基线草案、候选草案及审核状态。评估复用当前管家/领域 Agent 与 Stage21 计划服务；生成候选只保存新版本且不预约、不点餐、不释放/占用容量。自动激活沿用 Stage22 统一事务：抽检样本和慢病、过敏/忌口或待核实档案强制人工审核，当前规则/时段/容量重核失败时保持候选待审、旧预约不变。30 日心情趋势只显示有真实来源事件的标记，并链接来源心情 ID、候选版本及审核状态；相关性不作为因果或疗效结论。详见[第30轮报告](../wangshanchong/第30轮报告.md)及独立验收后续结论。
- Stage23 将助手提出的业务动作保存在 `assistant_action_cards`，类型为 `book_program`、`cancel_booking`、`book_meal`、`swap_dish`、`record_metric`、`rest_change`。状态包括 `needs_input`、`pending_confirmation`、`confirmed`、`stale`、`expired`、`rejected`、`superseded`、`failed`；同一逻辑动作递增版本并链接前序卡。提议与补问只写助手运行、工具收据和确认卡，不提前更改预约、菜单/订单或指标。确认端点绑定 guest、会话、版本和幂等键，在同一业务服务内重新核验时效、容量、状态、健康限制及来源快照，成功后保存真实业务 ID 与当前状态；失败、过期或依据变化以卡片状态和错误码呈现。`agent_runs.stop_reason` 记录明确停止原因；运行查询包含模型/工具调用计数、Token/成本来源、耗时与确认卡，供界面回读。Stage23 业务与当前资源门已通过；批准的 R01–R20 和 API-HISTORY-01 仅作为一次性历史例外接受，旧缺失事件仍保留。此前受限 Q23.2 live 尝试及失败记录见[第29轮报告](../wangshanchong/第29轮报告.md)。Stage24 的 `PASS_WITH_ACCEPTED_HISTORY_EXCEPTION` 由 Sol 独立业务与当前全资源双门验收，详见[第30轮报告](../wangshanchong/第30轮报告.md)。Stage25 执行任务自验 Q25.1–Q25.8、58 项测试及构建通过；Sol 独立业务和全资源复核仍待完成，详见[第31轮报告](../wangshanchong/第31轮报告.md)。
- `auto` 策略仅允许健康信息已完整核实、无慢病/用药/过敏或行动风险、无待核实自述、未抽中人工审核且活动仍通过当前规则与容量复核的计划自动激活。风险项保持人工审核；失败不会留下部分预约。餐食建议不是餐单或点餐，Stage22 不创建/修改 `meal_orders`。
- 医护修订、纠正按请求人、动作、幂等键及规范化请求内容指纹查重；同一键与同一内容重放原修订版本/纠正结果，同键不同内容返回冲突，缺少旧请求指纹的历史记录不做不安全重放。纠正仅取消仍有效且关联原疗程版本的项目预约，补偿、改版、激活和本地通知在一个事务内完成；无邮件/外部消息发送。
- Q21.5 对运动库存采用目标日期严格匹配的只读来源证据。库存对象、逐项目计数及汇总必须完整、数值有效且一致；协调器和子运行、必需工具、模型步骤、日期及来源必须通过完整性检查。协调器只选择营养候选时，只有能证明目标日期真实活动时段数与潜在可用数均为 0，才可保存带来源的运动缺口；缺失、非法、互相矛盾或日期不符的库存不视为 0，真实可用时段大于 0 而协调器未选运动候选仍拒绝。零库存证明只适用于它自己的日期，其他日期标注未查询，不借用计数或来源。项目 demo 时窗不会变成真实排程，也不会因此创建预约或占用容量。修复后的离线双库及Sol独立真实主路径均已通过：真实父/运动/营养来源、5模型/4工具、实际0库存、7日42项pending_review草案及回读有效，未创建预约或订单；验收收据见[第27轮最终结论](../wangshanchong/第27轮报告.md#stage21最终独立验收与交接2026-10-04)。
- 疗程协调器使用明确的`coordinationTask='wellness_draft'`选择契约及源日期；传入的`adoptedCandidateIds`白名单与`adoptedCandidates`载荷一致。所选候选必须通过schema、白名单、响应完整性及`semanticValid`校验；真实缺少必需餐位时拒绝保存，不以规则补选冒充模型采纳。运动候选只可来自实际可用窗口；通用聊天的合法空选择不受疗程专用契约强制。可审计的输入/输出摘要保留有界计数、字段名和哈希，不展示隐藏推理或完整敏感请求。
- 助手健康关键词仍保存为与会话关联的 `source='assistant'` 原文 pending 采集；表单和助手共用客人修订序列。助手上下文中的有效过敏/忌口约束包括正式资料、尚待核实的明确限制及冲突来源 ID；它不会自动确认自述，也不构成通用推荐或临床规则引擎。
- 助手会话 ID 由服务端生成，关联用户、助手角色及可选客人上下文，并记录 active/closed/expired 状态和到期时间。继续会话时检查用户、角色、会话状态、到期时间与客人上下文；不匹配会返回 403 或 409。
- 聊天消息保存在 `assistant_messages`。客人输入命中健康信息关键词时，当前实现还会将原文写入关联会话的 `health_intakes`（`status='pending'`），记录提交人和共享修订号并写入审计。医护可在工作台查看或驳回原文；没有结构化候选的旧文本不能直接确认并合并正式档案。
- 发给外部模型的客人上下文有意排除姓名、电话、房间号、出生日期和紧急联系人；是否启用外部模型取决于 `LLM_BASE_URL` 与 `LLM_API_KEY`。
- Stage16 餐食服务复用 Stage12 的正式、pending 和 legacy 有效过敏/忌口及来源 ID；不从菜名猜成分，不以客群偏好覆盖硬限制。正式信息未填写/不确定时展示待核实提示；无法精确映射的明确限制会导致餐位不足，不会猜测菜品安全性。规则与供货标签都是本地演示资料，不代表营养检测、实际库存或出餐能力。订单状态和餐点时刻均明确标出估算边界；Stage20 营养智能体不在本阶段范围。

## 5. 主要结构化错误码

以下代码由当前路由和授权逻辑产生；各错误的 HTTP 状态与中文说明由具体请求场景决定。

| 类别 | 错误码 |
| --- | --- |
| 鉴权/角色 | `AUTH_REQUIRED`、`AUTH_INVALID`、`AUTH_INVALID_CREDENTIALS`、`ACCOUNT_INACTIVE`、`ROLE_FORBIDDEN`、`CAPABILITY_FORBIDDEN` |
| 客人授权 | `GUEST_ID_REQUIRED`、`GUEST_ID_INVALID`、`GUEST_NOT_FOUND`、`GUEST_INACTIVE`、`GUEST_FORBIDDEN`、`GUEST_NOT_ASSIGNED` |
| 注册 | `REGISTER_PHONE_INVALID`、`REGISTER_PASSWORD_INVALID`、`REGISTER_PASSWORD_MISMATCH`、`REGISTER_NAME_INVALID`、`REGISTER_PHONE_TAKEN` |
| 员工/岗位能力 | `STAFF_INPUT_INVALID`、`STAFF_PASSWORD_INVALID`、`STAFF_JOB_TYPE_INVALID`、`STAFF_USERNAME_TAKEN`、`STAFF_UPDATE_INVALID`、`STAFF_STATUS_INVALID`、`STAFF_SELF_LOCKOUT`、`CAPABILITY_FIXED`、`CAPABILITY_JOB_TYPE_INVALID`、`CAPABILITY_UPDATE_INVALID` |
| 入住/分工 | `STAY_FILTER_INVALID`、`STAY_INPUT_INVALID`、`STAY_PLAN_INVALID`、`STAY_DATE_RANGE_INVALID`、`STAY_LIMIT_EXCEEDED`、`ASSIGNMENT_STAFF_REQUIRED`、`STAFF_INACTIVE`、`ASSIGNMENT_EXISTS`、`ASSIGNMENT_ID_INVALID`、`ASSIGNMENT_NOT_FOUND`、`ASSIGNMENT_ALREADY_CLOSED` |
| 每日简报/站内通知 | `DAILY_BRIEF_DATE_INVALID`、`NOTIFICATION_NOT_FOUND` |
| 资料/密码 | `PROFILE_GUEST_ONLY`、`PROFILE_INVALID_BODY`、`PROFILE_FIELD_NOT_ALLOWED`、`PROFILE_NO_FIELDS`、`PROFILE_FIELD_INVALID`、`PROFILE_NOT_READY`、`PASSWORD_CURRENT_INVALID`、`PASSWORD_NEW_INVALID` |
| 健康自述/核实 | `HEALTH_PROFILE_INVALID_BODY`、`HEALTH_PROFILE_FIELD_NOT_ALLOWED`、`HEALTH_PROFILE_FIELD_INVALID`、`HEALTH_PROFILE_VERSION_REQUIRED`、`HEALTH_PROFILE_EMPTY`、`HEALTH_PROFILE_STALE_VERSION`、`HEALTH_REVIEW_FIELD_NOT_ALLOWED`、`HEALTH_REVIEW_REASON_REQUIRED`、`HEALTH_INTAKE_NOT_FOUND`、`HEALTH_INTAKE_NOT_PENDING`、`HEALTH_INTAKE_UNSTRUCTURED`、`HEALTH_INTAKE_BASE_VERSION_MISMATCH`、`HEALTH_INTAKE_ALREADY_REVIEWED` |
| Stage21/22 初评、提取、疗程生成与审核 | `HEALTH_ASSESSMENT_INPUT_INVALID`、`HEALTH_ASSESSMENT_FIELD_INVALID`、`HEALTH_ASSESSMENT_VERSION_INVALID`、`HEALTH_ASSESSMENT_SESSION_INVALID`、`HEALTH_ASSESSMENT_ANSWER_INVALID`、`HEALTH_ASSESSMENT_ANSWER_REQUIRED`、`HEALTH_ASSESSMENT_STALE_VERSION`、`HEALTH_EXTRACTION_INPUT_INVALID`、`HEALTH_EXTRACTION_TEXT_INVALID`、`HEALTH_EXTRACTION_SCHEMA_INVALID`、`HEALTH_EXTRACTION_TRUNCATED`、`HEALTH_EXTRACTION_BUDGET_EXCEEDED`、`HEALTH_EXTRACTION_FAILED`、`HEALTH_EXTRACTION_DECISION_INVALID`、`HEALTH_EXTRACTION_DECISIONS_REQUIRED`、`HEALTH_EXTRACTION_NEEDS_CLARIFICATION`、`HEALTH_EXTRACTION_ALREADY_DECIDED`、`HEALTH_EXTRACTION_NOT_FOUND`、`ASSISTANT_SESSION_NOT_FOUND`、`WELLNESS_DRAFT_REQUEST_INVALID`、`WELLNESS_DRAFT_INPUT_INVALID`、`WELLNESS_DRAFT_NOT_FOUND`、`WELLNESS_STAY_INVALID`、`WELLNESS_REGENERATION_INVALID`、`WELLNESS_REGENERATION_STATE`、`CLINICIAN_REQUIRED`、`STAFF_MANAGEMENT_REQUIRED`、`WELLNESS_VERSION_STALE`、`WELLNESS_REVIEW_STATE`、`WELLNESS_REASON_REQUIRED`、`WELLNESS_REVISION_INVALID`、`WELLNESS_ITEM_INVALID`、`WELLNESS_ITEM_NOT_FOUND`、`WELLNESS_ITEM_NOT_READY`、`WELLNESS_SLOT_REQUIRED`、`WELLNESS_SLOT_EVIDENCE_MISSING`、`WELLNESS_SLOT_UNAVAILABLE`、`WELLNESS_HISTORY_ACTION_INVALID`、`WELLNESS_HISTORY_DATE_INVALID`、`WELLNESS_HISTORY_FORBIDDEN`、`WELLNESS_CORRECTION_RESULT_MISSING`、`IDEMPOTENCY_KEY_INVALID`、`IDEMPOTENCY_KEY_REUSED`、`IDEMPOTENCY_REPLAY_UNVERIFIABLE` |
| 新闻/工作人员/意见/建议 | `NEWS_NOT_FOUND`、`STAFF_NOT_FOUND`、`REVIEW_INVALID`、`ADVICE_INVALID` |
| 助手角色/文本 | `ASSISTANT_ROLE_INVALID`、`ASSISTANT_ROLE_FORBIDDEN`、`ASSISTANT_TEXT_INVALID`、`ASSISTANT_TEXT_REQUIRED`、`ASSISTANT_TEXT_TOO_LONG` |
| 助手会话 | `ASSISTANT_SESSION_REQUIRED`、`ASSISTANT_SESSION_NOT_FOUND`、`ASSISTANT_SESSION_FORBIDDEN`、`ASSISTANT_SESSION_INACTIVE`、`ASSISTANT_GUEST_CONTEXT_MISMATCH` |
| 助手运行/确认卡 | `ASSISTANT_RUN_FORBIDDEN`、`ASSISTANT_ACTION_CONFIRM_INPUT_INVALID`、`ASSISTANT_ACTION_INPUT_INVALID`、`ASSISTANT_ACTION_FORBIDDEN`、`ASSISTANT_ACTION_NOT_FOUND`、`ASSISTANT_ACTION_VERSION_STALE`、`ASSISTANT_ACTION_IDEMPOTENCY_INVALID`、`ASSISTANT_ACTION_STALE`、`ASSISTANT_ACTION_TYPE_INVALID`、`ASSISTANT_ACTION_EXECUTION_FAILED` |
| 项目/知识/规则/环境 | `PROJECT_NOT_FOUND`、`PROJECT_ID_REQUIRED`、`PROJECT_CATEGORY_INVALID`、`PROJECT_FIELD_INVALID`、`PROJECT_FIELD_NOT_ALLOWED`、`PROJECT_UPDATE_EMPTY`、`PROJECT_OPEN_WINDOW_INVALID`、`PROJECT_CAPACITY_INVALID`、`PROJECT_ACTIVE_INVALID`、`KNOWLEDGE_DOMAIN_INVALID`、`CATALOG_SEARCH_INVALID`、`RULE_EVALUATION_FIELD_NOT_ALLOWED`、`CLINICIAN_REQUIRED`、`GUEST_REQUIRED`、`ENVIRONMENT_INVALID`、`ENVIRONMENT_DATE_INVALID`、`ENVIRONMENT_FIELD_NOT_ALLOWED`、`ENVIRONMENT_UV_INVALID`、`ENVIRONMENT_SEA_STATUS_INVALID`、`ENVIRONMENT_SOURCE_INVALID` |
| 排期/预约/容量 | `SLOT_DATE_INVALID`、`SLOT_RANGE_INVALID`、`SLOT_DATE_OUT_OF_RANGE`、`SLOT_ID_INVALID`、`SLOT_NOT_FOUND`、`SLOT_NOT_AVAILABLE`、`SLOT_WINDOW_CHANGED`、`SLOT_FULL`、`SLOT_CLOSED`、`SLOT_PAST`、`SLOT_UPDATE_INVALID`、`SLOT_CAPACITY_INVALID`、`SLOT_CLOSED_INVALID`、`CAPACITY_BELOW_BOOKED`、`IDEMPOTENCY_KEY_INVALID`、`IDEMPOTENCY_KEY_REUSED`、`RESERVATION_INPUT_INVALID`、`RESERVATION_NOT_FOUND`、`RESERVATION_TIME_CONFLICT`、`RESERVATION_ALREADY_STARTED`、`STAY_NOT_ACTIVE`、`PROJECT_INACTIVE` |
| 膳食菜单/订单 | `MEAL_DATE_INVALID`、`MEAL_DATE_OUTSIDE_STAY`、`MEAL_TYPE_INVALID`、`MEAL_MENU_INPUT_INVALID`、`MEAL_MENU_NOT_FOUND`、`MEAL_MENU_FORBIDDEN`、`MEAL_MENU_VERSION_INVALID`、`MEAL_MENU_STALE_VERSION`、`MEAL_MENU_INCOMPLETE`、`MEAL_ITEM_NOT_FOUND`、`MEAL_DISH_REQUIRED`、`MEAL_DISH_NOT_FOUND`、`MEAL_DISH_UNAVAILABLE`、`MEAL_DISH_SLOT_MISMATCH`、`MEAL_DISH_RESTRICTED`、`MEAL_RESTRICTION_UNMAPPED`、`MEAL_SWAP_REASON_REQUIRED`、`MEAL_SWAP_INPUT_INVALID`、`MEAL_IDEMPOTENCY_KEY_REQUIRED`、`MEAL_IDEMPOTENCY_CONFLICT`、`MEAL_ORDER_INPUT_INVALID`、`MEAL_ORDER_ALREADY_EXISTS`、`MEAL_ORDER_NOT_FOUND`、`MEAL_ORDER_IN_PROGRESS`、`MEAL_ORDER_STATUS_INVALID`、`MEAL_ORDER_STATUS_INPUT_INVALID`、`MEAL_ORDER_TRANSITION_INVALID` |
| 心情与陪伴资源 | `MOOD_INVALID_BODY`、`MOOD_FIELD_NOT_ALLOWED`、`MOOD_SCORE_INVALID`、`MOOD_NOTE_INVALID`、`MOOD_ALREADY_RECORDED`、`MOOD_RECORD_NOT_FOUND`、`MOOD_RECORD_CHANGED`、`MOOD_EDIT_WINDOW_CLOSED`、`MOOD_TREND_WINDOW_INVALID`、`MOOD_RESOURCE_NOT_FOUND`、`MOOD_RESOURCE_UNAVAILABLE`、`MOOD_RESOURCE_EVENT_INVALID` |
| 请求/服务器 | `INVALID_JSON`、`INTERNAL_ERROR` |

项目目录和安全规则均为可读 API；项目与时段维护仅对院长/管理员开放。Stage15 预约服务在写入时复核最新开放窗口、入住日期、环境/健康规则、容量、冲突和幂等键；更改窗口不会批量取消预约，旧窗口 slot 保留但变为不可预约。取消只释放名额并保留历史；schedule 只投影仍有效预约。Stage16 只保存确定性演示菜单与订单：按正式、待核实及旧档案明确过敏/忌口硬筛选，再应用演示客群偏好；无法精确映射的限制阻止相关写入。每餐的菜单和订单快照可追溯；已进入备餐/送达的餐次不能换菜；订单仅允许 `reserved → preparing → delivered`。预计送餐时刻、菜品供应和营养标签都是显式演示资料，不代表临床建议、检测、库存或履约。环境默认关闭，实时模式要求显式双开关及全部机构配置；当前双库和浏览器验收只用本地 fixture/demo，不代表真实数据或安全标准。Stage16 不接营养智能体、支付或真实供应系统。规则条件是需求演示策略，不构成诊断或个体治疗建议。知识和规则目录不由助手自动执行。

Stage17–Stage22 现均通过 Sol 独立业务与资源退出、清理双门。Stage23 业务及当前资源门通过，且按用户决定接受 R01–R20 与 API-HISTORY-01 的一次性历史例外；对应旧历史记录没有补造或覆盖，见[第29轮报告](../wangshanchong/第29轮报告.md)及[批准与交接](阶段23历史例外批准与交接_20261008.md)。Stage24 Q24.1–Q24.8 与恢复后的 Stage25 Q25.1–Q25.8 均由 Sol 独立通过业务与当前全资源双门，结论为 `PASS_WITH_ACCEPTED_HISTORY_EXCEPTION`，见[第30轮报告](../wangshanchong/第30轮报告.md)和[第31轮报告](../wangshanchong/第31轮报告.md)。Stage26 Q26.1–Q26.13、58 项测试及构建由执行任务自验通过；Sol 独立复跑关键业务与全部资源验收待完成，未获得双门结论前不衔接 Stage27，见[第32轮报告](../wangshanchong/第32轮报告.md)。本地隔离验收不代表生产迁移、真实机构服务或 109 项 RTM 全部通过；导入与回退边界见[迁移与回退指南](MySQL迁移与回退.md)。
