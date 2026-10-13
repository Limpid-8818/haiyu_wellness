# 阶段4无模型合成验收

政策先定于`docs/阶段4候选餐单与时间政策_20261014.md`。使用新caller/new attempt/新合成SQLite，不读任何私密.env、不调用真实provider。`api.js`断言Key/Base/Model为空；Vite设resource managed绕过loadEnv。只初始化专用演示五岗及已有目录，注册/入住/分工/健康核实/菜单/订单/替换/核对/备餐送达全部用产品路由，没有SQL补业务。

现有依赖和Playwright只读复用，不安装/复制；自建node_modules链接须准确删除。持久Node REPL导入绝对路径`controller.js`：

```js
const stage4 = await import('file:///绝对项目路径/scripts/bugfix-stage4/controller.js');
const c = await stage4.createController({
  taskId: '01a0cbfe-a161-72d0-992d-12fad655d4ef',
  attempt: 'source-stage4-independent-20261014-01',
  date: '2026-10-14', // 采用实际客户端上海业务日期
  apiPort: 58918, webPort: 58919
});
await c.command('prepare');
await c.command('menus');
await c.command('restrictions');
await c.command('before');
await c.command('late');
await c.command('future');
await c.command('midnight');
await c.command('afterMidnight');
await c.command('fulfillStart');
await c.command('fulfillEnd');
await c.command('verify');
await c.command('close'); // 成功/失败/阻塞均必须收尾
```

每phase≤40秒/browser≤30秒；lease15min、日志8MiB/temp512MiB；普通终端OS硬60、runner45。启动自动核空闲，不杀占用者。business clock初始07:30上海，late13:15、midnight23:59、次日00:05与00:10，每次变化先精确退出自有API再同库启动一个替代API；OS时间和租期不变，不两API同时。全部时刻/UTC及资源身份写owner记录。

三case为：三日规则餐单、理由、同日多样/跨日轮换、重复生成/刷新/重登录/人工替代稳定；明确海鲜限制与未知蛋制品人工分类、订单暂停/拒绝推进、安全替换/配餐复核恢复；餐次前后/次日/上海跨午夜下单、明确无ETA、常规时刻分开、同订单配餐备餐送达/客人回读与幂等。第三case使用同库同客人的独立餐次，不伪造旧订单时刻；最后菜单/订单HTTP/网页与只读SQL关联验证。

SQLite旧expected_delivery_at非空字段继续存原演示常规时刻，API expectedDeliveryAt=null，新增regularServingAt与未知说明，历史字段不批改。生成只用目录规则，AI来源候选未重新运行/改写，不把本验收标为AI图完成。

`browser.json`实际断言/HTTP/小卡片PNG与`owner.json`只读SQL共同判断业务；最后resourceResult与真实`owner-exit.json`判断退出。再用`audit-resource-scope.js`对本阶段worker/Sourcecaller全部登记核准确身份/句柄/temp/socket/端口及缺口，审计自身另核，删除自己的链接。不能只把phase.ok/按钮禁用/纯函数测试当业务PASS。

Source独验前worker Git0、F07/F08仅候选，报告78/79分别worker/Source；整体NOT_FINAL_ACCEPTED/109未验/旧FAIL保持，5/6未派。Source独验通过后才另授权同部分整合收尾。

worker前两attempt未完成（select标签严格匹配失败、API健康修改后未挂载核对面板/响应超时），旧图片/异常日志/只读摘要保留；第三独立attempt全12phase通过，工具已按实际select和健康修改后的整页刷新修正、Promise拒绝有界接住。不要把旧INCOMPLETE记为未发生菜单/订单写入，也不拼旧对象凑新case。worker已停止，不再短重跑；Source使用自身新caller/attempt独验。
