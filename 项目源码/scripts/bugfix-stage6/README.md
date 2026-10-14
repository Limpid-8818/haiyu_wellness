# 阶段6受控回归工具（首尝试FAIL，未就绪）

只原App01a13810-f5fc-73d0-9306-36fed3a8b3ca/local，U01/U07/U08/U09/D01/V03。第86轮BLOCKED不改，第87轮补充受控模型授权，第88轮记录首完整attempt失败。Source89未运行。不要直接把本工具当作Source已就绪包；须Source审评后在同任务授权必要修复与新attempt，不能自动重试。

## 已执行命令

`checks.py`固定OS60/subprocess55/ResourceRunner45、15min/8MiB/512MiB，LLM Key/Base/Model空，独占内存SQLite、环境unavailable、scheduler0。tests01和tests02均81/81，build01/build02均0；最新实际命令在对应checks/*.json，完整测试列表为原15文件78项加release-presentation.test.js三项。

唯一attempt `worker-stage6-release-20261014-01`、worker58924/25。持久Node REPL导入controller，依次prepare/catalog/baselineStart/observe/approve/before/restriction/afterMidnight/atStart；每次检查ok。atStart失败，随后只读snapshot失败，close成功，禁止继续feedback或重新POST。每command≤40秒、浏览器≤30秒；模型start只一个原生POST、observe有限18秒，同图不重发。

owner仅一个ResourceSession，专用演示team新SQLite、真实HTTP注册/入住/负责关系/健康核实。隔离目录stage2-indoor-exercise明确合成，业务ID全部生产生成。clock变化先准确退出自有API再替换，相同DB；浏览器注入对应合成时钟，不改OS。API loader才进程内存白名单读取main .env所需三个LLM字段，ledger只有request/response SHA、HTTP/usage；累计模型HTTP≤20、原生graph≤2，已有50/16384/12/90和cost cap不改。此次实际1图/5成功HTTP，第二图未跑；后续不得默默重置这5次/1图的账。

## 两个待Source审批的工具修复

1. atStart应只验证开始时签到，独立serviceEnd阶段按实际预约endsAt准确替换自有API后再完成/反馈。此次09:00预约至10:00（具体以响应实际endsAt为准），脚本在09:00提交completed，生产SERVICE_TOO_EARLY校验正确拒绝。不要修改产品结束时间门或把409当服务成功。
2. data.js错误引用未安装better-sqlite3；现有项目使用自身SQLite适配器/运行时。先静态核真实驱动，再只读连接新合成库导出，表名也按现有schema校准（service_executions等），不能安装/复制依赖、SQL造业务或回填首尝试SQL缺口。首尝试自身临时库已准确删除，SQL缺证保持。

新完整尝试还需自然反馈v2待审/guest+clinician回读/重复evaluate不再调用、普通三餐配餐及健康/心情刷新、三尺寸和展开溯源、真实更正通知（当前只纯分类测试覆盖）、同对象只读SQL。原失败与PNG不能拼新PASS。新caller/预算须Source明确安排，失去旧合成库后不能伪恢复或用新对象补旧链。

## 资源收尾

close后owner-exit.json真实child exit0。通过checks.py调用audit-resource-scope，root为整个output/resource-audit/bugfix-stage6，包含worker与Source真实UUID；audit自己另由post-audit.js核4准确身份退出、guardian0、2组空、句柄/temp/socket0。最后一个node_modules参数只删执行者确实新建且精确指向main依赖的链接，目标保持。

首尝试资源双门PASS不等于业务PASS。worker仍Git0、六BUG不完成、109未全验/NOT_FINAL_ACCEPTED/旧FAIL/CI延后保持。完整证据及包索引见第88轮，任务只主动回Source一次后停止。
