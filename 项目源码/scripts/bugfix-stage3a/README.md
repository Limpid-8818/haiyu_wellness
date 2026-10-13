# 阶段3A独立复跑

范围仅F04/F06/R01/U05，V01及后续不在本包。真实调用worker上限2（已消费），Source上限1。不得复用旧guest/session/run/attempt。仅在本隔离worktree运行，主.env仅受管API进程白名单读取LLM_BASE_URL/API_KEY/MODEL，不复制、不输出，模型Key不传浏览器或guardian资源配置。

## 静态与测试

实际产品默认为50模型请求、16384总Token、12工具、90秒；模板一致。主.env白名单检查只有显式50和LLM_TIMEOUT_MS60000，未发现Token覆盖。主私密.env不需worker写入；Source须核合入后实际日常status，若另一配置显式8192，公开预算迁移应是16384，不能保留验收特调。

在项目源码以实际caller的CODEX_TASK_ID和独占auditRoot执行，每条外层用Python `signal.alarm(60)` + `os.execvp`，runner45秒，lease900000/log8388608/temp536870912。只有自身可移除node_modules链接，只读指向已有主目录依赖；不得安装复制。

```sh
DB_DRIVER=sqlite DB_PATH=:memory: DEMO_SEED=0 LLM_API_KEY='' LLM_BASE_URL='' ENVIRONMENT_MODE=unavailable ENVIRONMENT_LIVE=0 \
node scripts/resources/resource-runner.js --task-id "$CODEX_TASK_ID" --audit-root "output/resource-audit/bugfix-stage3a/$CODEX_TASK_ID/runtime" --kind test --name stage3a-targeted --timeout-ms 45000 --cwd . --no-output -- \
node --test --test-concurrency=1 server/test/agent-presentation.test.js server/test/agent-status.test.js server/test/assistant-agents.test.js server/test/agent-context-projection.test.js server/test/graph-budget.test.js server/test/staff-journeys.test.js server/test/service-stop-contract.test.js server/test/meal-restriction-recovery.test.js server/test/wellness-adoption.test.js server/test/environment-mock.test.js

node scripts/resources/resource-runner.js --task-id "$CODEX_TASK_ID" --audit-root "output/resource-audit/bugfix-stage3a/$CODEX_TASK_ID/runtime" --kind build --name stage3a-build --timeout-ms 45000 --cwd . --no-output -- npm run build
```

40测试包含阶段1/2原18项。agent-status使用独立`:memory:`和本地provider故障stub，只验失败/授权/默认/持久回读，不能冒充真实模型PASS。其他测试不加载私密.env。

## 真实网页：稳定owner分步

通过persistent node_repl导入controller；不用普通命令挂90秒。controller创建独立owner进程，owner只开一个ResourceSession及一个API/Vite/browser组。每个command≤40秒；owner保持async图运行，租期15分钟。传入执行者实际ID，不用worker身份冒充Source。Source端口58910/58911启动前自动探空闲，不杀占用者。

```js
var mod = await import('file:///Users/wangshanchong/.codex/worktrees/28d6/haiyu_wellness/项目源码/scripts/bugfix-stage3a/controller.js');
var acceptance = await mod.createController({
  taskId: '01a0cbfe-a161-72d0-992d-12fad655d4ef',
  attempt: 'source-independent-20261013-01', apiPort: 58910, webPort: 58911
});
nodeRepl.write(await acceptance.command('prepare'));
// 下一短工具调用：唯一真实attempt，从正常网页输入/按钮发async:true。
nodeRepl.write(await acceptance.command('submit'));
// 每次观察短调用；queued/running时在调用之间等待，直到terminal，禁止重发。
nodeRepl.write(await acceptance.command('observe'));
// terminal后：最终答复/六缺项、四域/协调器、来源、主页/刷新/重新登录PNG，SQL只读。
nodeRepl.write(await acceptance.command('verify'));
// 无论PASS/FAIL/工具错误都必须close；确认state.exit真实退出。
nodeRepl.write(await acceptance.command('close'));
nodeRepl.write(acceptance.state.exit);
```

verify的 `ok:true` 只表示工具完成，必须同时 `result.businessResult==='PASS'`（四专业完成、协调器model/schema/白名单完成、9实际请求/8工具、实报usage），owner resourceResult PASS和新caller资源audit PASS才是双门。不要将父run存储completed单独当整体成功；缺域/协调器失败另为partial_failure。worker实测首attempt父completed但业务FAIL/主页partial_failure，原件保持。prepare前置失败没有submit，不消耗真实attempt；所有旧工具失败/图片/登记不改写。

## 资源审计

close准确退出浏览器→Vite→API/全部子进程、guardian，并查句柄/socket/deleted-open后清自身temp。owner-exit.json由父控制器实际child exit event留证，不推断退出码。审计用受管runner45秒执行 `scripts/resources/audit-resource-scope.js --task-id <实际scope> --executing-app-thread-id <实际Source> --root <选定runtimeRoot> --out <该root内唯一json>`，读取后再核审计自身runner/guardian准确退出与cleanup/tempRemoved。

Source分别覆盖worker整个runtimeRoot与自身runtimeRoot；不能用空的自身范围替代worker旧失败资源。最后移除自身依赖链接，确认58908—58911相关任务端口无监听，不碰用户服务/Chrome/VSCode/旧11clone。worker/source证据均ignored output，只提交小复跑工具与报告。

历史NOTE：worker首前置失败用了不存在的guest_demo越权ID，得到404；修正为已存在guest_001后403通过。首次构建JSX语法FAIL及控制器node_repl没有process全局的工具错误全部保留在第70轮，真实调用重试不超过2。源码不使用强制协作hook，建议未采纳不创建业务对象。
