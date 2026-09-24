# 海屿康养社区智能康养系统

这是海屿康养社区四角色 SQLite MVP 的开发交付包。先阅读 [交接文档](交接文档_海屿康养社区.md) 和 [现行 API 与运行契约](docs/API运行契约.md)。[开发基线](docs/开发基线.md) 与 [API 基线快照](docs/API当前基线.md) 是基于 `67813a1` 的历史记录，不描述当前组合工作区。文档中的早期疗程、预约、潮汐、膳食和医护审核需求是后续扩展，不能当作当前功能已完成的证明。

## 环境与工作目录

- 所有 npm 命令都在 `项目源码/` 执行；仓库根目录没有可运行的 npm package。
- Node.js 22 或更高版本，npm 10 或更高版本。
- 包管理器使用 npm workspaces；不要用 pnpm 代替本项目的 `package-lock.json`。
- 当前 API 使用 Node 内置 `node:sqlite`，不需要额外安装 SQLite 服务。

## 安装、启动、测试和构建

```bash
cd 项目源码
npm ci --ignore-scripts
npm run dev
```

开发环境同时启动前端和 API：

- 前端：http://localhost:5180
- API：http://localhost:3020/api
- 健康检查：http://localhost:3020/api/health

本地副本需要避开已占用端口时，可显式覆盖 API 端口、Vite 端口和 API 代理目标：

```bash
cd 项目源码
PORT=24520 WEB_PORT=25520 API_PROXY_TARGET=http://127.0.0.1:24520 npm run dev
```

`WEB_PORT` 与 `API_PROXY_TARGET` 示例也列在 `.env.example` 中。该文件不会自动加载，需像上面的命令一样从 shell 显式提供变量。

常用命令：

```bash
cd 项目源码
npm test
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

示例见 [`项目源码/.env.example`](项目源码/.env.example)。源码不会自动读取 `.env` 文件；必须由 shell、进程管理器或 CI 显式导出环境变量。按本 README 从 `项目源码/` 运行根工作区的 `npm start` 或 `npm run dev` 时，API 由 `server` workspace 启动，进程工作目录为 `项目源码/server/`，所以 `.env.example` 中的相对值 `DB_PATH=./data/community-v2.sqlite` 指向 `项目源码/server/data/community-v2.sqlite`。相对 `DB_PATH` 始终按 API 进程工作目录解析；从其他目录直接运行 Node 时需相应调整。

```bash
cd 项目源码
export PORT=3020
export DB_PATH="$PWD/server/data/community-v2.sqlite" # 等价于 server workspace 中的 .env.example 相对值
export AUTH_SECRET='replace-with-a-random-32-byte-secret'
export LLM_BASE_URL=''
export LLM_API_KEY=''
export LLM_MODEL='gpt-4o-mini'
export LLM_TIMEOUT_MS=20000
export ASSISTANT_SESSION_TTL_MS=28800000
npm start
```

`AUTH_SECRET` 必须替换为随机强密钥，不能使用源码默认值或演示值。只有同时设置 `LLM_BASE_URL` 和 `LLM_API_KEY` 才会尝试调用 OpenAI-compatible `/chat/completions`；留空时使用安全引导模式。不要把真实密钥提交到仓库。

`LLM_TIMEOUT_MS` 控制模型请求超时，默认 20,000 毫秒；正数有效，超过 120,000 毫秒时按 120,000 计算，缺失、非正数或无效值使用默认值。`ASSISTANT_SESSION_TTL_MS` 控制新助手会话有效期，默认 28,800,000 毫秒（8 小时），最大按 604,800,000 毫秒（7 天）计算；缺失、非正数或无效值使用默认值。修改环境变量后需重启 API。

`DB_PATH` 可以指向临时测试库或持久 SQLite 文件；自定义路径的父目录会在 API 启动时自动创建。正式 MySQL 目标脚本仍在 [`数据库设计/haiyu_wellness_mysql8.sql`](数据库设计/haiyu_wellness_mysql8.sql)，应用层迁移尚未完成。

## 演示账号

| 角色 | 用户名 | 密码 |
| --- | --- | --- |
| 客人 | `guest_demo` | `guest2026` |
| 工作人员 | `staff_demo` | `staff2026` |
| 院长 | `dean_demo` | `dean2026` |

这些账号只用于本地课程演示，不能用于生产环境。

## 当前范围与后续阶段

当前组合源码注册 20 个 API 路由，提供公开新闻、四角色页面、Bearer HMAC 登录、客人资料白名单更新、按有效分工授权的工作人员客人工作台、院长团队记录与意见，以及具备会话所有权和客人上下文隔离的助手 API。助手没有可用模型时会降级到安全引导模式。分工管理 API、健康采集审核流程、MySQL 应用迁移以及疗程/预约等早期 RTM 能力仍未实现。准确路由、角色范围、错误码和表结构见[现行契约](docs/API运行契约.md)；GitHub Actions、真实模型与 109 条 RTM 的状态不得据此推断为已通过。

原始数据库目标、设计材料和需求矩阵保留在 `数据库设计/`、`概要设计/`、`项目依据/`；不要把 109 条 RTM 的设计占位或 `×` 以外的文档描述当成自动化测试证据。
