# 数据库设计

## 1 设计决策

MVP 使用 Node 24 内置 `node:sqlite`，以 `server/data/seaside-wellness.sqlite` 保存快照，避免额外原生依赖；表结构已在 [`schema.sql`](../原型(1)/prototype/server/db/schema.sql) 中给出。领域代码暂保留易演示的内存对象模型，每次状态变更响应完成后写入 SQLite，启动时恢复快照。上线版本按同一字段拆分为 PostgreSQL 表。

## 2 主要实体关系

```text
users 1──1 guest_profiles
guest_profiles 1──N plans 1──N plan_reviews
guest_profiles 1──N reservations N──1 programs
guest_profiles 1──N health_metrics
guest_profiles 1──N mood_checkins
users 1──N audit_logs
```

## 3 关键约束

- `plans.tier=mandatory` 时，只有 `approve` 或 `modify` 才能转为 `active`。
- `reservations` 按 `program_id + date + time + guest_id` 唯一，避免重复预约。
- 所有指标保存数值 JSON、单位、来源和记录时间，血压允许高低压双值。
- 审核前后方案使用 JSON 快照，保证驳回、修改和抽检可追溯。
- 生产库禁止存明文密码；`password_hash` 仅存 Argon2id/bcrypt 摘要。

## 4 迁移路径

1. MVP：快照表 `app_state`，适合课堂演示和单实例部署。
2. 联调：按 `schema.sql` 建表，编写 snapshot-to-relational 导入脚本并做行数/金额/预约数校验。
3. 上线：PostgreSQL + Redis（会话/限流）+ 对象存储（音频资源），启用每日备份和 30 天审计保留策略。
