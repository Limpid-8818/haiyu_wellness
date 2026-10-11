# SQLite / MySQL 运行、导入与回退

## 运行模式

服务默认使用 SQLite。DB_DRIVER 只能设为 sqlite 或 mysql；MySQL 连接失败时服务明确退出，不会回退到 SQLite 写入。

| 变量 | SQLite | MySQL |
| --- | --- | --- |
| DB_DRIVER | sqlite，也可省略 | 必须显式设为 mysql |
| DB_PATH | 数据库文件路径；默认 server/data/community-v2.sqlite | 不使用 |
| MYSQL_HOST | 不使用 | 主机名，默认 127.0.0.1 |
| MYSQL_PORT | 不使用 | 必填端口 |
| MYSQL_USER | 不使用 | 必填账号 |
| MYSQL_PASSWORD | 不使用 | 密码；不得写入仓库 |
| MYSQL_DATABASE | 不使用 | 必填且需预先创建的数据库名 |
| MYSQL_POOL_SIZE | 不使用 | 连接池大小，默认 10，上限 20 |
| DEMO_SEED | 仅设为 1 时尝试插入演示账号 | 仅设为 1 时尝试插入演示账号 |

服务连接 MySQL 后先执行 SELECT 1 和服务器版本检查，再运行版本化迁移。当前迁移版本为 22：v1–v11 建立核心业务表、目录、排期/预约、菜单/订单与结构化健康指标；v12 增加 3 张心情与本地资源事件表；v13 增加 3 张助手运行追踪表；v14–v16 为助手补充持久化补问、父子运行/执行模式和模型诊断字段；v17 增加 4 张健康初评/提取/疗程草案表；v18 扩展疗程草案与预约关联并增加 3 张审核事件/关注/本地通知表；v19 增加审核请求重放索引；v20 扩展审核事件动作约束以区分医护修订后批准；v21 增加 `assistant_action_cards` 并为 `health_records` 添加来源会话关联；v22 为 `agent_runs` 添加显式 `stop_reason`。当前有 34 张业务表、3 张助手运行追踪表及单独的 `schema_migrations` 元数据表。v11、v14–v16、v19–v20、v22 不新建业务表。SQLite 与 MySQL 的迁移都按版本检查，新增列/索引有存在性检查；v6 目录由迁移种入且标示 `is_demo`，不依赖 `DEMO_SEED`。v7 仅在 `knowledge-exercise-02` 仍保存精确旧来源值时更新该目录记录，不覆盖已修改来源。v8 环境 payload 用 MySQL JSON；v9 业务日期是上海本地日期、预约时刻用 UTC `DATETIME(3)`；v10 保存限制依据、版本化菜单、订单快照与幂等键，供应状态和预计送餐时间标为演示值；v11 只在旧健康记录类型、单位和值格式明确时创建结构化值，不把无法解析的原文伪装为有效指标。v21 的动作卡保存结构化参数、影响、版本、依据和结果 JSON；v22 的 `stop_reason` 长度为 96，运行追踪仍不导入 SQLite 用户数据迁移。账号演示种子独立于迁移，只在 `DEMO_SEED=1` 且 users 为空时插入。日常启动应省略 DEMO_SEED 或设为 0。

MySQL 示例：

~~~sh
DB_DRIVER=mysql \
MYSQL_HOST=127.0.0.1 \
MYSQL_PORT=3306 \
MYSQL_USER=haiyu_app \
MYSQL_PASSWORD='替换为本地秘密' \
MYSQL_DATABASE=haiyu_wellness \
npm start
~~~

执行 npm run quest -- --stage 10 --db=mysql 会在两个数据库后端运行关卡。MySQL 关卡需要连接到独立的 MySQL 8.x 测试实例；测试账号还需有创建、删除临时数据库以及迁移所需 DDL 的权限。关卡使用随机命名库并在结束时删除。

## 迁移导入

1. 先对当前 SQLite 文件做一致性检查并创建单独副本；停止会写入源库的应用进程，再复制或使用数据库工具生成副本。
2. 创建一个目标 MySQL 数据库，配置 MySQL 环境变量并启动应用，让版本化迁移创建目标表。
3. 执行 `node scripts/import-sqlite-to-mysql.js /绝对路径/到/批准的.sqlite副本`。脚本以只读方式打开来源文件，导入 11 张基础表、`activity_slots` 与 `reservations` 两张 Stage15 表，以及 `meal_menus`、`meal_menu_items`、`meal_orders`、`meal_order_requests` 四张 Stage16 客人数据表；默认演示数据库路径被拒绝。菜品目录由目标端 v10 迁移种子提供，不导入来源副本。项目、知识、规则目录、岗位能力与环境快照也由目标端迁移/种子提供。
4. 检查命令返回的 17 张表来源数、目标数、重复数和 30 个关系校验结果。重复主键只记录并跳过，不更新 MySQL 里的自定义手机号或其他字段。Q10.9 验证预约/时段和膳食菜单/订单合成样例导入、重复导入零新增与源文件哈希不变；v11 新增的 `health_records.voided_by` 关系也须通过检查。
5. 在独立验证库运行 npm run quest -- --stage 10 --db=mysql。该阶段在 MySQL 8.4.11 上已逐项通过。

SQLite 到 MySQL 的字段、日期、JSON、主键、索引和约束差异见[字段映射](SQLite到MySQL字段映射.md)。

## 回退

若需把服务进程切回 SQLite，先停止当前 API，再显式设置 DB_DRIVER=sqlite 和 DB_PATH 指向迁移前保留的 SQLite 原件或验证副本，然后重新启动。数据库驱动不会自动切换，MySQL 不可用时也不会自动改写 SQLite。

MySQL 与 SQLite 当前不是双写系统。切换到 MySQL 后产生的新写入不会自动回传 SQLite。因此，回切前必须确认 MySQL 切换后的写入已停止且可丢弃，或先由业务方完成单独的数据对账/回放；直接切回旧 SQLite 会看不到 MySQL 期间的新数据。不要把整个 MySQL 数据目录或活动数据库文件覆盖到原 SQLite 文件。

Q10.10 的回退关卡使用合成数据分别保留不可变来源、SQLite 运行副本和回退副本：完成 MySQL API 流程并关闭 MySQL API 后，再把新 SQLite API 进程重启到从来源克隆的回退副本，实测 guest、staff、dean 三种合成角色都能登录。该过程验证配置切回与原副本可用，不声称 MySQL 期间的写入会自动合并进 SQLite。

如果目标 MySQL 需要重新启用，保留原 SQLite 副本不动，重新配置 DB_DRIVER=mysql 及 MySQL 参数即可。导入器的重复主键策略不会把一边的修改覆盖到另一边；数据对账应使用新建的目标库和经批准的来源副本。

## 本轮验证边界

2026-09-29，隔离 MySQL 8.4.11（回环地址端口 33408）通过 Q10.1–Q10.10；导入来源是合成 SQLite 文件，SHA-256 导入前后相同。2026-09-30 阶段13另在端口 33413 的全新隔离 MySQL 8.4.11 上验证 v6/v7 和 Q13.1–Q13.10，见[第18轮报告](../wangshanchong/第18轮报告.md)。2026-10-01 阶段14在端口 33414 的独立隔离实例验证 v8 和 Q14.1–Q14.7，见[第19轮报告](../wangshanchong/第19轮报告.md)。第20轮在新建独立 MySQL 8.4.11 datadir（回环端口 33416）验证 v9、Q15.1–Q15.10，并重跑 Q14.1–Q14.7、Q13.1–Q13.10、Q10.1–Q10.10；所有命令退出码均为 0。Stage16 在新建隔离 MySQL 8.4.11 实例（回环端口 33418）验证 v10、Q16.1–Q16.10 和 Stage15 回归；并重跑 Stage10–14 指定 Quest。Q10.1–Q10.10 覆盖 23 张业务表、17 张导入表和 30 个关系检查，导入夹具包含 Stage15 时段/预约与 Stage16 菜单/订单样例。Stage17 在独立的 MySQL 8.4.11 临时数据目录（回环端口 33420）验证 v11、Q17.1–Q17.7 与回归；临时实例验收后停止并清理。当前结果只证明本地隔离数据库，不证明生产部署、生产数据迁移或生产回退。

2026-10-05 Sol 对 Stage23 的独立复验在受管 ResourceRunner 临时实例中重新通过 Q23.6 的 SQLite/MySQL 双库关卡，并全量重跑 Stage19（Q19.1–Q19.12，两库）；`npm test` 为 51/51，`npm run build` 成功。Stage23 的 Q23.1–Q23.9 有独立双库离线通过记录；其中 Q23.9 浏览器验收在受保护 Chrome 身份/缓存基线预检阶段阻塞，未启动浏览器，也未改动用户进程或缓存。Stage20 的离线 Q20.1–Q20.6 双库通过，Q20.7 浏览器门受同一基线差异阻塞。Stage23 整体仍 BLOCKED：此前唯一一次 Q23.2 live 调用在模型预算处失败且未重试；另有无法恢复的早期临时 API PID 身份记录缺口。当前双库结果只证明合成隔离环境，不能替代真实模型、浏览器或历史资源完整门，也不代表生产迁移或生产回退。详见[第29轮报告](../wangshanchong/第29轮报告.md)与[Stage23 Sol 复核记录](阶段23验收复核_20261005.md)。
