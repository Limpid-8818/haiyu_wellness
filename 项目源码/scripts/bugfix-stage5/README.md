# 阶段5环境当前性与历史独验

仅F09/F10/U02/U03/U04/U06，worker82候选，Source83独验。无真实模型、用户库、MySQL、scheduler或CI；不自动批准/预约，不新增机构阈值。沿用28d6/main既有依赖，只读链接，最后只删自己的链接。所有路径按实际项目绝对路径替换；Source使用自己的task/caller/attempt，不复用worker guest/SQLite/profile。

## 本地回归与构建

`checks.py`固定OS alarm60、subprocess55、ResourceRunner45、lease900000、log8388608、temp536870912，清洁环境且LLM Key/Base/Model空、managed Vite跳过loadEnv，LANG/LC_ALL=UTF-8避免macOS ps中文路径转义。完整78项（原65+本阶段13）命令：

```sh
python3 scripts/bugfix-stage5/checks.py <Source UUID> source-tests01 node --test --test-concurrency=1 server/test/environment-currentness.test.js server/test/environment-history-api.test.js server/test/meal-policy-time.test.js server/test/wellness-four-domain-adoption.test.js server/test/wellness-run-evidence.test.js server/test/agent-presentation.test.js server/test/agent-status.test.js server/test/assistant-agents.test.js server/test/agent-context-projection.test.js server/test/graph-budget.test.js server/test/staff-journeys.test.js server/test/service-stop-contract.test.js server/test/meal-restriction-recovery.test.js server/test/wellness-adoption.test.js server/test/environment-mock.test.js
python3 scripts/bugfix-stage5/checks.py <Source UUID> source-build01 npm run build
```

原65中的recorded-provider图只为继承回归夹具，不算真实模型。新测试包括纯resolver异常/匹配/取点、生产API+tool.execute+brief、追加版本保全、历史草案/brief哈希和demo时区；新草案仅保存与生成时ID精确匹配的已有来源元数据，匹配不到的历史ID不回填新值。tests01旧时间夹具FAIL、tests04原生builder date/businessDate字段FAIL及修正后tests05全通过均保留，不清除旧FAIL。

## 唯一公开供应商组

优先核阶段5公共配置白名单授权。本脚本逐行流式过滤名称后才提取13个公开值，不复制全.env，不提取任何LLM/Auth/DB/QWeather Key。`public-config.json`仅公开字段；与已提交大连代表点文档比较，差异如实报告。只接官方Weather/Marine公开endpoint，每次新out最多两次fetch，无重试，原始响应、URL、HTTP、真实时间、SHA与生产适配器结果单列。

```sh
python3 scripts/bugfix-stage5/checks.py <Source UUID> source-capture01 node scripts/bugfix-stage5/capture.js output/playwright/bugfix-stage5/<Source UUID>/live01 <实际上海日期> /Users/wangshanchong/Codes/haiyu_wellness/项目源码/.env
```

Source只1组。成功后下面原生API对这一次真实响应**隔离回放**，不再请求外部；区别于合成异常场景，不能称每次网页刷新为新真实查询。原capture status不是PASS则保留原件、报告LIVE_BLOCKED，不自行编PASS或另加组。

## 新caller的三个网页case

持久Node REPL导入绝对路径controller，API/Vite/browser独占一组；每phase≤40秒、browser≤30秒，最多owner一个ResourceSession；普通外层运行再用ResourceRunner时最多两Session。worker58920/21，Source58922/23。每个配置/时钟变化先精确退出自有API，同一个合成SQLite重启；不改OS/用户服务。客户端日期注入也只在独占浏览器里。

```js
const stage5 = await import('file:///绝对项目路径/scripts/bugfix-stage5/controller.js');
const c = await stage5.createController({taskId:'01a0cbfe-a161-72d0-992d-12fad655d4ef',attempt:'source-stage5-environment-independent-20261014-01',date:'2026-10-14',apiPort:58922,webPort:58923,capture:'/绝对项目路径/output/playwright/bugfix-stage5/01a0cbfe-a161-72d0-992d-12fad655d4ef/live01'});
await c.command('prepare');
// 每次检查ok；失败先保留原件并close，不自动重试。
await c.command('missing');
await c.command('stale');
await c.command('unavailable');
await c.command('multiple');
await c.command('invalid_time');
await c.command('demo');
await c.command('point');
await c.command('zero');
await c.command('uvMissing');
await c.command('live');
await c.command('history');
await c.command('verify');
await c.command('close'); // 无论业务结论如何都收尾
```

三case：异常与逐域来源（多版本/换合成地点/切demo/坏时间）；同一12点生产API、brief、tool.execute、实际卡片且0/无UV区分，live另用真实采集小时；旧草案和初始不可用brief冻结、换当前地点、guest日程和负责医护审核台读取，SQL原件SHA前后一致，审核事件/预约/agent_runs0。prepare注册/入住/医护分工用产品HTTP；`freeze`明确记录recorded_fixture旧休息条目，source_run_id空、parentRunId为冻结夹具标签，不声称真实生成/采纳或批准。异常SQL仅隔离环境快照；没有SQL补网页业务。所有工具直接生产runAssistantTool/execute，不调用LLM。

`owner.json`记录逐域实际source、点时刻、配置变化、只读哈希及准确资源；`browser.json`是163断言/30显式登记HTTP/17原生卡片PNG与可见文字（数量以Source实际结果为准）。框架不声称登记了所有浏览器后台GET。live实际raw响应hash要与tide.sourceResponseHash、marine.providerResponseHash及sourceMarineSnapshotKey核对。图中代表点、预测、全球平均海平面/非台站/无精确满干潮说明不可删。PNG人工查看live-environment、point-brief、history-guest、history-staff，悬浮播放器可能遮卡片最底部，完整可见文本另存browser.json。

worker尝试01—04 INCOMPLETE/FAIL保留：null/undefined、T与空格/措辞断言、UV缺失分级说明、历史testid差异。05新guest整套11phase/3case PASS。不能把前四次记为未执行，也不拼旧guest结果成新PASS；Source必须新caller全跑。

## 资源审计和自身退出

先close并核owner-exit.json，再审本阶段根；`--out`必须留在所选resource-audit根里：

```sh
python3 scripts/bugfix-stage5/checks.py <Source UUID> source-audit01 node scripts/resources/audit-resource-scope.js --task-id <Source UUID> --executing-app-thread-id <Source UUID> --include-task-id 01a137d6-4a10-72d1-b1c6-268507dafce6 --root output/resource-audit/bugfix-stage5 --out output/resource-audit/bugfix-stage5/<Source UUID>/resource-final.json
node scripts/bugfix-stage5/post-audit.js output/resource-audit/bugfix-stage5/<Source UUID>/resource-final.json output/resource-audit/bugfix-stage5/<Source UUID>/runtime/registry.jsonl output/resource-audit/bugfix-stage5/<Source UUID>/post-audit-self.json node_modules
```

最后一个node_modules参数仅在本Source确实新建该只读链接时使用；若没创建则省略，不能删别人的链接。post-audit核审计自己已退出准确fingerprint、guardian真实exit0、两组空、句柄/temp/socket，再删除确属自己的链接并保全main目标。普通命令也OS硬60秒。worker audit01中文路径转义FAIL、audit02输出目录合同FAIL原件保留，audit03 PASS/自身另核4身份PASS，不修资源基础脚本或历史缺口。

Source独验前Git暂存/commit/merge/push0；六BUG仅候选。双门通过后才逐部分整合main、标原BUG已完成、普通push核SHA；6未派，NOT_FINAL_ACCEPTED/109未全验/旧FAIL及例外保持。worker完成只主动回Source一次停止，不轮询。
