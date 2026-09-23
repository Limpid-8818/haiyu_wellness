# API 契约（MVP）

所有接口前缀为 `/api`。当前原型使用 `x-token` 头；生产版本改为短时 access token + HttpOnly refresh cookie。

## 公共

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/auth/login` | 客人/员工登录，返回角色和会话令牌 |
| GET | `/health` | 服务健康检查 |
| GET | `/programs` | 项目库 |
| GET | `/programs/:id/slots` | 未来 7 天时段、潮汐安全和剩余容量 |

## 客人端

`GET/PUT /profile` 健康档案；`POST /chat` 对话与工具调用；`GET /chat/history` 历史；`GET /plan` 疗程；`POST /plan/regenerate` 重生成；`GET /schedule` 日程；`POST/DELETE /reservations` 预约/取消；`GET /brief` 每日简报；`GET/POST /moods` 心情；`GET/POST /metrics` 健康指标；`POST /checkin` 项目打卡。

错误响应统一为 `{ "error": "可读中文原因", "code": "OPTIONAL_CODE" }`，安全校验失败返回 400，未登录 401，无权限 403，不存在 404。

## 机构端

`GET /reviews` 审核队列；`GET /reviews/:planId` 审核详情；`POST /reviews/:planId/approve` 通过；`POST /reviews/:planId/modify` 修改并通过；`POST /reviews/:planId/reject` 驳回并触发重生成；`GET /staff/customers` 客户列表；`GET /staff/customers/:id` 客户详情；`GET /staff/reservations` 预约总览；`GET /staff/overview` 运营概览；`GET /rules` 禁忌规则。

## 事件与审计

状态变更必须写入 `store.logs`（迁移后写入 `audit_logs`）。推荐事件名：`profile.update`、`plan.generate`、`plan.adjust`、`review.approve`、`review.reject`、`reservation.create`、`reservation.cancel`、`metric.record`。
