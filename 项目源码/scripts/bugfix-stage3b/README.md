# 阶段3B Source独验入口

仅用于隔离的合成SQLite业务验收。现有私密配置由受管API进程白名单读取，Key不传入浏览器或guardian。`recorded-provider.js`只供定向测试，不用于真实验收。依赖复用已存在的安装，不安装、不复制；资源限额为15分钟租期、8MiB日志、512MiB临时目录。

在持久Node REPL中导入绝对路径的`controller.js`，调用：

```js
const stage3b = await import('file:///绝对项目路径/scripts/bugfix-stage3b/controller.js');
const controller = await stage3b.createController({
  taskId: '01a0cbfe-a161-72d0-992d-12fad655d4ef',
  attempt: 'source-stage3b-independent-20261014-01',
  apiPort: 58914,
  webPort: 58915
});
await controller.command('prepare');
await controller.command('submit'); // 唯一真实四域图；不得重复提交
await controller.command('observe'); // 若仍执行中，在独立短调用中观察
await controller.command('adopt');   // 仅在terminal completed后执行
await controller.command('review');
await controller.command('verify');
await controller.command('close');  // 无论成功、失败或阻塞都必须执行
```

每个controller调用上限40秒、browser阶段30秒；普通终端命令仍需OS硬60秒，resource-runner建议45秒。图运行的90秒是受管异步图限额，不是单命令时限。默认共享50请求/16384Token/12工具；不得临时抬高Token预算。新attempt目录必须不存在，客人/session/run从新库自然生成。

`prepare`仅在新库初始化演示五岗和明确合成的室内教练项目，入住、医护关系和资料确认走实际API。business clock固定为配置日期08:00（上海），不改系统时钟；源建议次日、修订运动后日，均在三晚入住期内。项目时段通过原生GET物化；不SQL补业务、不scheduler、不触碰真实用户库。mock/不可用环境不能放行户外活动。

验收路径：原生聊天→四域真实协作→原生采纳及重复点击→持久待审v1→四域来源和陪伴音频→刷新及重登录→负责医护修订v2→旧版/错版拒绝→关闭较晚时段审批失败且前序预约原子回滚→开放后原生修改通过并激活→批准重放无重复占位→客人同版/同预约回读→只读SQL对照。

`owner.json`的businessResult、SQL及`browser.json`共同判定业务；`close`的resourceResult及真实`owner-exit.json`判定退出。随后用`audit-resource-scope.js`检查本Source及worker当前阶段所有登记、准确进程身份、句柄、临时目录和socket，审计自身关闭后另做准确身份核对。不能只把phase.ok或配置可用当成业务通过。

worker已用两个真实图：live01采纳后网页定位失败，未执行审核激活；live02完成闭环，review首次定位失败后同图继续成功，原失败快照保留。worker已停止，不能第三次图。`08-clinician-approval.png`只证明批准通知，未展示完整医护已激活详情；此工具在worker关闭后增加独立`08a-clinician-active-detail.png`采集，尚未运行，由Source新独验覆盖。不要声称worker已存在该截图。

Source尚未消耗其唯一真实图。Source75独验通过前worker Git写0；BUG-V01保持候选待验，阶段4—6未派发。
