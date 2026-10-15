> 当前版本与交付边界：[当前版本与验收状态](docs/当前版本与验收状态_20261014.md)。阶段6核心整改已合入main；V03 Source新live终验、截图P3和109全验仍待补。

# 海屿康养社区智能康养系统

> 新开发者请先看[前后端启动手册](docs/开发者启动手册.md)，其中包含安装、SQLite/MySQL、分开启动、构建、代理和当前验收边界。前端代码组织（目录结构、依赖方向、useQuery/hash 路由等约定）见[前端代码组织与架构](docs/前端代码组织与架构_20261015.md)。

> 当前BUG修复入口（2026-10-13）：请先阅读[待修复BUG列表](待修复BUG列表.md)和[交接说明](docs/BUG修复交接_20261013.md)。已有真实四领域与管家运行（9模型/8工具）证据，但最终答复、采纳业务闭环及其他岗位仍有问题/未验项，整体仍 `NOT_FINAL_ACCEPTED`。当前 `.env.example` 包含50次模型上限和大连地区代表点公开环境配置，私密Key与本地用户数据库不在仓库。

> 历史核心验收状态（2026-10-12）：第1轮入口、第2轮资料/桌面网页及第3A轮机构前置已独立通过限定核心范围；第3B轮原“四领域同一 run/session 的持久方案”合同为 `BLOCKED_STATIC_DEPENDENCY`。当时选项2的两个拆分流程尚未执行，109条需求仍未全验，`NOT_FINAL_ACCEPTED` 保持。见[核心验收计划](docs/合并后核心可用性验收计划_20261012.md)及[第46轮交付报告](wangshanchong/第46轮报告.md)。

> 源端最新R5结论（2026-10-11）：Q27.7/Q27.8业务通过；Q27.9源05:09行级证据通过，05:11阶段汇总退出2、NOT_FINAL_ACCEPTED。映射33 PASS/76 BLOCKED，功能103 UNVERIFIED/6受限子场景。源资源门PASS_WITH_ACCEPTED_HISTORY_EXCEPTION；外层cwd执行违规保留，原546,982 B前缀完整、两条新增实例已追溯和清理，资源门无待审项。详见[逐项清单与串行计划](docs/阶段27剩余需求与后续最小阶段清单_20261011.md)及[第38轮报告](wangshanchong/第38轮报告.md)。 本轮D1只修改指定文档；未运行Quest、测试、安装、provider、API、MySQL或浏览器。

这是海屿康养社区四角色应用的本地开发交付包，默认使用 SQLite，也可通过 `DB_DRIVER` 显式切换到 MySQL 8.x。先阅读[交接文档](交接文档_海屿康养社区.md)和[现行 API 与运行契约](docs/API运行契约.md)。[开发基线](docs/开发基线.md)与[API 基线快照](docs/API当前基线.md)基于旧 `67813a1`，不描述当前组合工作区。Stage15 的预约/容量/日程、Stage16 的确定性演示膳食、Stage17 的健康指标和 Stage18 的心情记录/陪伴资源均有本地实现。

**历史R5首次worker执行快照（源端额外冷验前）：源端 R1–R4 已独立通过（保留已批准的历史例外）；源Sol另已独立通过 Q27.7。本轮 Q27.8 干净交付在唯一一次 worker 冷安装、构建和58项测试通过后、启动 dev 前因脚本 TDZ 错误失败。TDZ 入口已有离线修正，但修正后的 dev、preview、浏览器四场景和 SQLite 备份恢复未运行，Q27.8 仍为 FAIL。Q27.9 映射完整不代表109项功能全部验收；阶段27仍未最终通过。**R4 的源端 Q27.6 对用户选择的 Open-Meteo 默认模式做过一次有界实测：天气、海况及含潮汐的模式海面高度各24小时，并核对来源/网格/时间与同一快照在 API、缓存、数据库和页面间的一致性。此证据不代表当前持续新鲜度、官方潮位站读数、机构现场安全阈值或生产连通性；所选默认模式不需要 QWeather 站点凭据。详情见[本地交付说明](docs/阶段27本地交付说明.md)、[第38轮报告](wangshanchong/第38轮报告.md)和[源端R5复核](docs/阶段27R5首次源独立复核_20261011.md)。项目运营、菜品供应和 Stage18 情绪关注规则仍为演示资料，不代表真实服务或心理诊断。

## 环境与工作目录

- 所有 npm 命令都在 `项目源码/` 执行；仓库根目录没有可运行的 npm package。
- Node.js 22.13.0 或更高版本，npm 10 或更高版本。此最低 Node 版本支持无需实验标志的内置 `node:sqlite`。
- 包管理器使用 npm workspaces；不要用 pnpm 代替本项目的 `package-lock.json`。
- 默认 SQLite 驱动使用 Node 内置 `node:sqlite`；显式选择 MySQL 时使用 `mysql2/promise` 连接池。连接失败不会自动切到另一个数据库。

## 安装、启动、测试和构建

```bash
cd 项目源码
npm ci --ignore-scripts
npm run dev
```

如果拿到的是完整工作区，从工作区根目录进入 `项目源码/`；如果拿到的是单独的 `项目源码/` 交付目录，它本身就是 npm 项目根目录，直接在该目录执行上面的 npm 命令，无需再运行 `cd 项目源码`。默认本地交付只使用 SQLite 和安全助手引导模式，不需要真实模型或环境服务密钥。

MySQL 8 双库关卡在隔离测试实例上运行；连接变量、迁移、导入与回退说明见[迁移与回退指南](docs/MySQL迁移与回退.md)。

开发环境同时启动前端和 API：

- 前端：http://127.0.0.1:5180
- API：http://localhost:3020/api
- 健康检查：http://localhost:3020/api/health

本地副本需要避开已占用端口时，可显式覆盖 API 端口、Vite 端口和 API 代理目标：

```bash
cd 项目源码
PORT=24520 WEB_PORT=25520 API_PROXY_TARGET=http://127.0.0.1:24520 npm run dev
```

`WEB_PORT` 与 `API_PROXY_TARGET` 示例也列在 `.env.example` 中。复制为 `项目源码/.env` 后，Vite 开发服务器会读取这两项；命令行显式设置的值优先。

常用命令：

```bash
cd 项目源码
npm test              # server 侧测试（node --test）
npm run test -w web   # web 侧测试（Vitest：lib 单测 + 渲染冒烟）
npm run lint -w web   # web 侧 eslint
npm run build
npm start                 # 仅启动 API
```

测试请使用临时 SQLite 文件，避免污染持久演示库：

```bash
cd 项目源码
DB_PATH="$(mktemp -d)/haiyu-community-test.sqlite" npm test
```

`npm run build` 的产物位于 `项目源码/web/dist`。GitHub Actions 在 `项目源码/` 使用 Node 22、`npm ci --ignore-scripts`、临时 `DB_PATH`、`npm test` 和 `npm run build`，不自动部署。

## 环境变量

本地配置位于 `项目源码/.env`，示例见 [`项目源码/.env.example`](项目源码/.env.example)。从 `项目源码/` 执行 `npm start` 或 `npm run dev` 时，API 启动脚本会读取该文件；Vite 仅读取其中的 `WEB_PORT` 和 `API_PROXY_TARGET`，不会把 `LLM_API_KEY` 送到浏览器。shell、进程管理器或 CI 显式设置的同名变量优先。直接执行 `node server/src/index.js` 不会加载 `.env`。API 进程工作目录为 `项目源码/server/`，所以示例中的相对值 `DB_PATH=./data/community-v2.sqlite` 指向 `项目源码/server/data/community-v2.sqlite`；从其他目录直接运行 Node 时需相应调整。

```bash
cd 项目源码
export PORT=3020
export DB_PATH="$PWD/server/data/community-v2.sqlite" # 等价于 server workspace 中的 .env.example 相对值
export AUTH_SECRET='replace-with-a-random-32-byte-secret'
export ASSISTANT_SESSION_TTL_MS=28800000
npm start
```

`AUTH_SECRET` 必须替换为随机强密钥，不能使用源码默认值或演示值。`.env.example` 提供 `LLM_BASE_URL=https://api.deepseek.com`、`LLM_MODEL=deepseek-flash` 示例；复制为本地配置后填写 `LLM_API_KEY` 并重启 API。更换兼容服务时修改这三个 `LLM_*` 值。只有同时设置 `LLM_BASE_URL` 和 `LLM_API_KEY` 才会尝试调用 OpenAI-compatible `/chat/completions`；key 留空时使用安全引导模式。`.env` 已被 Git 忽略，不要把真实密钥提交到仓库。

`LLM_TIMEOUT_MS` 控制模型请求超时，默认 20,000 毫秒；正数有效，超过 120,000 毫秒时按 120,000 计算，缺失、非正数或无效值使用默认值。`ASSISTANT_SESSION_TTL_MS` 控制新助手会话有效期，默认 28,800,000 毫秒（8 小时），最大按 604,800,000 毫秒（7 天）计算；缺失、非正数或无效值使用默认值。修改环境变量后需重启 API。

`DB_DRIVER` 省略时为 `sqlite`；SQLite 使用 `DB_PATH`，自定义路径的父目录会在 API 启动时自动创建。MySQL 必须显式设为 `DB_DRIVER=mysql`，并提供 `MYSQL_HOST`、`MYSQL_PORT`、`MYSQL_USER`、`MYSQL_DATABASE` 和必要的 `MYSQL_PASSWORD`。服务启动时运行 v1–v28 增量迁移（v4 岗位能力、v5 健康档案扩展、v6–v8 目录/规则/环境快照、v9 预约、v10 膳食、v11 健康指标、v12 心情记录，v13–v28 陆续覆盖助手运行、疗程草案与审核、业务确认、签到反馈、每日简报、运营排期、膳食限制复核、服务执行和热路径索引；迁移名单见 `server/src/db.js`）。连接错误不会触发 SQLite fallback。导入器只从显式指定的 SQLite 副本导入基础用户表、预约表和膳食菜单/订单表；菜品目录由迁移种子提供。原始目标脚本仍在 [`数据库设计/haiyu_wellness_mysql8.sql`](数据库设计/haiyu_wellness_mysql8.sql)，字段差异见[SQLite 到 MySQL 映射](docs/SQLite到MySQL字段映射.md)。

## 演示账号

| 角色 | 用户名 | 密码 |
| --- | --- | --- |
| 客人 | `guest_demo` | `guest2026` |
| 工作人员 | `staff_demo` | `staff2026` |
| 院长 | `dean_demo` | `dean2026` |

这些账号只用于本地课程演示，不能用于生产环境。

需要完整五岗位与全链演示数据（审核队列、餐食订单、指标趋势、心情记录等）时，在开发实例启动后执行 `cd 项目源码 && npm run demo:mock`，账号与数据清单见[演示模式使用指引](docs/演示模式使用指引.md)。

新建数据库不会默认写入演示账号。只有显式设置 `DEMO_SEED=1` 且 users 表为空时才会写入；数据库迁移本身不运行种子脚本。

## 当前范围与后续阶段

当前组合源码在[现行 API 契约](docs/API运行契约.md)中登记123条 API 路由，覆盖公开新闻、客人注册、五种工作人员岗位、入住/负责关系、健康资料、项目目录、知识与规则、环境快照、预约、膳食菜单/订单、心情与陪伴资源等功能。Stage14 增加天气、潮汐/海况适配器与快照缓存；Stage15 增加未来七天时段网格、原子容量预约、幂等和时间冲突检查、取消历史、日程投影及管理员容量/窗口维护。Stage16 的菜品/菜单/订单、Stage17 的健康指标/趋势、Stage18 的心情记录/陪伴资源均为本地实现；菜单、配方、标签、供货状态、订单时刻、音频与关注规则是演示资料，不代表临床建议、营养检测、真实库存、履约服务或心理诊断。预约写入会复核入住、环境与健康规则；开放窗口修改后旧时段不可预约，既有预约不批量取消。

环境运行仍默认离线/不可用，除非明确启用获准的提供方模式。源端 R4 Q27.6 曾对用户选择的 Open-Meteo 默认模式做过一次有界实测：24小时天气、海况和含潮汐的模式海面高度数据通过来源/网格/时间检查，并在 API、缓存、数据库和页面复用同一快照。该记录不证明当前持续新鲜度、正式机构位置精度、官方潮位站实测、现场安全阈值或生产连通性；所选默认模式不要求 QWeather Key/Station。缺失/过期环境仍不会放行下海项目，演示规则与模式海面高度不替代现场判断。阶段19–26的当前验收状态以各自日期明确的轮次报告为准，不沿用旧版“尚未开始”的概述。Stage15浏览器证据见[第20轮报告](wangshanchong/第20轮报告.md)，Stage16双库/浏览器闭环见[第21轮报告](wangshanchong/第21轮报告.md)，Stage17指标证据见[第23轮报告](wangshanchong/第23轮报告.md)，Stage18本地关卡与浏览器证据见[第24轮报告](wangshanchong/第24轮报告.md)。助手没有可用模型时会降级到安全引导模式。生产数据库切换、持续真实模型/环境服务、营养智能体、疗程与真实运营调度仍需按各自计划验收；本地关卡不代表 GitHub Actions、生产部署或109条 RTM 已整体通过。

原始数据库目标、设计材料和需求矩阵保留在 `数据库设计/`、`概要设计/`、`项目依据/`；不要把 109 条 RTM 的设计占位或 `×` 以外的文档描述当成自动化测试证据。
