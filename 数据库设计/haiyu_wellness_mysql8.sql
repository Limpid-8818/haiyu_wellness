-- 海屿康养社区智能康养系统
-- MySQL 8.0 一键建库脚本
-- 执行方式：mysql -u root -p < haiyu_wellness_mysql8.sql
-- 说明：脚本可重复执行；首次执行创建数据库、表、索引及演示数据。

SET NAMES utf8mb4;
SET @OLD_TIME_ZONE = @@SESSION.time_zone;
SET TIME_ZONE = '+08:00';
SET @OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS;
SET FOREIGN_KEY_CHECKS = 0;

CREATE DATABASE IF NOT EXISTS haiyu_wellness
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

USE haiyu_wellness;

CREATE TABLE IF NOT EXISTS users (
  id              VARCHAR(36)  NOT NULL COMMENT '用户唯一标识',
  username        VARCHAR(64)  NOT NULL COMMENT '登录账号',
  password_hash   VARCHAR(255) NOT NULL COMMENT 'scrypt盐值与摘要，格式salt:hash',
  role            VARCHAR(16)  NOT NULL COMMENT '角色：guest/staff/dean',
  name            VARCHAR(64)  NOT NULL COMMENT '姓名',
  phone           VARCHAR(32)  NULL COMMENT '联系电话',
  avatar_url      VARCHAR(500) NULL COMMENT '头像地址',
  status          VARCHAR(16)  NOT NULL DEFAULT 'active' COMMENT '账号状态：active/disabled/locked',
  last_login_at   DATETIME(3)  NULL COMMENT '最后登录时间',
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_users_username (username),
  KEY idx_users_role_status (role, status),
  CONSTRAINT ck_users_role CHECK (role IN ('guest','staff','dean')),
  CONSTRAINT ck_users_status CHECK (status IN ('active','disabled','locked'))
) ENGINE=InnoDB COMMENT='统一用户与角色表';

CREATE TABLE IF NOT EXISTS guest_profiles (
  user_id             VARCHAR(36)  NOT NULL COMMENT '客人用户编号',
  gender              VARCHAR(16)  NULL COMMENT '性别',
  birth_date          DATE         NULL COMMENT '出生日期',
  room_no             VARCHAR(32)  NULL COMMENT '房间号',
  check_in_date       DATE         NULL COMMENT '入住日期',
  check_out_date      DATE         NULL COMMENT '计划离店日期',
  emergency_contact   VARCHAR(128) NULL COMMENT '紧急联系人及电话',
  chronic_json        JSON         NOT NULL COMMENT '慢病标签数组',
  allergies_json      JSON         NOT NULL COMMENT '过敏标签数组',
  mobility            VARCHAR(128) NULL COMMENT '行动能力',
  service_preferences JSON         NULL COMMENT '康养服务偏好',
  created_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  updated_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
  PRIMARY KEY (user_id),
  KEY idx_guest_profiles_room (room_no),
  KEY idx_guest_profiles_stay (check_in_date, check_out_date),
  CONSTRAINT fk_guest_profiles_user FOREIGN KEY (user_id) REFERENCES users(id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT ck_guest_profiles_dates CHECK (
    check_out_date IS NULL OR check_in_date IS NULL OR check_out_date >= check_in_date
  )
) ENGINE=InnoDB COMMENT='客人机构档案表';

CREATE TABLE IF NOT EXISTS staff_guest_assignments (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '负责关系编号',
  staff_id    VARCHAR(36)     NOT NULL COMMENT '工作人员编号',
  guest_id    VARCHAR(36)     NOT NULL COMMENT '客人编号',
  start_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '负责开始时间',
  end_at      DATETIME(3)     NULL COMMENT '负责结束时间',
  status      VARCHAR(16)     NOT NULL DEFAULT 'active' COMMENT '状态：active/closed',
  created_by  VARCHAR(36)     NOT NULL COMMENT '分配操作人，通常为院长',
  created_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  updated_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_assignment_staff_guest_start (staff_id, guest_id, start_at),
  KEY idx_assignment_staff_status (staff_id, status),
  KEY idx_assignment_guest_status (guest_id, status),
  CONSTRAINT fk_assignment_staff FOREIGN KEY (staff_id) REFERENCES users(id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_assignment_guest FOREIGN KEY (guest_id) REFERENCES users(id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_assignment_creator FOREIGN KEY (created_by) REFERENCES users(id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT ck_assignment_status CHECK (status IN ('active','closed')),
  CONSTRAINT ck_assignment_dates CHECK (end_at IS NULL OR end_at >= start_at)
) ENGINE=InnoDB COMMENT='工作人员与客人负责关系表';

CREATE TABLE IF NOT EXISTS health_records (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '健康记录编号',
  guest_id     VARCHAR(36)     NOT NULL COMMENT '客人编号',
  record_type  VARCHAR(64)     NOT NULL COMMENT '指标类型，如血压、心率、睡眠',
  value_text   VARCHAR(128)    NOT NULL COMMENT '指标值，兼容138/86等复合值',
  unit         VARCHAR(32)     NULL COMMENT '单位，如mmHg、bpm、h',
  note         VARCHAR(1000)   NULL COMMENT '记录说明',
  source       VARCHAR(24)     NOT NULL DEFAULT 'staff' COMMENT '来源：guest/staff/device/assistant/import',
  recorded_at  DATETIME(3)     NOT NULL COMMENT '实际记录时间',
  recorded_by  VARCHAR(36)     NOT NULL COMMENT '记录人编号',
  created_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '入库时间',
  PRIMARY KEY (id),
  KEY idx_health_guest_time (guest_id, recorded_at DESC),
  KEY idx_health_type_time (record_type, recorded_at DESC),
  KEY idx_health_recorder (recorded_by, created_at DESC),
  CONSTRAINT fk_health_guest FOREIGN KEY (guest_id) REFERENCES users(id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_health_recorder FOREIGN KEY (recorded_by) REFERENCES users(id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT ck_health_source CHECK (source IN ('guest','staff','device','assistant','import'))
) ENGINE=InnoDB COMMENT='客人健康记录表';

CREATE TABLE IF NOT EXISTS medical_advice (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '医嘱或建议编号',
  guest_id    VARCHAR(36)     NOT NULL COMMENT '客人编号',
  author_id   VARCHAR(36)     NOT NULL COMMENT '发布工作人员编号',
  title       VARCHAR(200)    NOT NULL COMMENT '标题',
  content     TEXT            NOT NULL COMMENT '建议正文',
  priority    VARCHAR(16)     NOT NULL DEFAULT 'normal' COMMENT '优先级：normal/important/urgent',
  status      VARCHAR(16)     NOT NULL DEFAULT 'active' COMMENT '状态：draft/active/closed/revoked',
  source      VARCHAR(24)     NOT NULL DEFAULT 'manual' COMMENT '来源：manual/assistant_draft',
  confirmed_by VARCHAR(36)    NULL COMMENT '人工确认人编号',
  confirmed_at DATETIME(3)    NULL COMMENT '人工确认时间',
  closed_at   DATETIME(3)     NULL COMMENT '关闭时间',
  created_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  updated_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
  PRIMARY KEY (id),
  KEY idx_advice_guest_status_time (guest_id, status, created_at DESC),
  KEY idx_advice_author_time (author_id, created_at DESC),
  CONSTRAINT fk_advice_guest FOREIGN KEY (guest_id) REFERENCES users(id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_advice_author FOREIGN KEY (author_id) REFERENCES users(id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_advice_confirmer FOREIGN KEY (confirmed_by) REFERENCES users(id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT ck_advice_priority CHECK (priority IN ('normal','important','urgent')),
  CONSTRAINT ck_advice_status CHECK (status IN ('draft','active','closed','revoked')),
  CONSTRAINT ck_advice_source CHECK (source IN ('manual','assistant_draft'))
) ENGINE=InnoDB COMMENT='医嘱与康养建议表';

CREATE TABLE IF NOT EXISTS news (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '新闻编号',
  category     VARCHAR(64)     NOT NULL COMMENT '新闻分类',
  title        VARCHAR(200)    NOT NULL COMMENT '标题',
  summary      VARCHAR(500)    NOT NULL COMMENT '摘要',
  body         LONGTEXT        NOT NULL COMMENT '正文',
  cover_url    VARCHAR(500)    NULL COMMENT '封面地址',
  status       VARCHAR(16)     NOT NULL DEFAULT 'published' COMMENT '状态：draft/published/archived',
  pinned       TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '是否置顶',
  author_id    VARCHAR(36)     NULL COMMENT '发布人编号',
  published_at DATETIME(3)     NULL COMMENT '发布时间',
  created_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  updated_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
  PRIMARY KEY (id),
  KEY idx_news_status_pin_time (status, pinned DESC, published_at DESC),
  CONSTRAINT fk_news_author FOREIGN KEY (author_id) REFERENCES users(id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT ck_news_status CHECK (status IN ('draft','published','archived')),
  CONSTRAINT ck_news_pinned CHECK (pinned IN (0,1))
) ENGINE=InnoDB COMMENT='公开新闻与社区动态表';

CREATE TABLE IF NOT EXISTS audit_logs (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '审计日志编号',
  actor_id      VARCHAR(36)     NULL COMMENT '操作人编号，匿名操作可空',
  action        VARCHAR(100)    NOT NULL COMMENT '动作编码',
  target_type   VARCHAR(64)     NULL COMMENT '目标资源类型',
  target_id     VARCHAR(64)     NULL COMMENT '目标资源编号',
  detail_json   JSON            NULL COMMENT '脱敏后的操作详情',
  request_id    VARCHAR(64)     NULL COMMENT '请求追踪号',
  ip_address    VARCHAR(45)     NULL COMMENT '客户端IP，按策略脱敏',
  user_agent    VARCHAR(500)    NULL COMMENT '客户端标识',
  result        VARCHAR(16)     NOT NULL DEFAULT 'success' COMMENT '结果：success/failure/denied',
  created_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '操作时间',
  PRIMARY KEY (id),
  KEY idx_audit_actor_time (actor_id, created_at DESC),
  KEY idx_audit_target_time (target_type, target_id, created_at DESC),
  KEY idx_audit_action_time (action, created_at DESC),
  KEY idx_audit_request (request_id),
  CONSTRAINT fk_audit_actor FOREIGN KEY (actor_id) REFERENCES users(id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT ck_audit_result CHECK (result IN ('success','failure','denied'))
) ENGINE=InnoDB COMMENT='系统审计日志表';

CREATE TABLE IF NOT EXISTS staff_reviews (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '院长意见编号',
  staff_id   VARCHAR(36)     NOT NULL COMMENT '工作人员编号',
  dean_id    VARCHAR(36)     NOT NULL COMMENT '院长编号',
  content    TEXT            NOT NULL COMMENT '指导意见',
  status     VARCHAR(16)     NOT NULL DEFAULT 'active' COMMENT '状态：active/withdrawn',
  created_at DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  updated_at DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
  PRIMARY KEY (id),
  KEY idx_reviews_staff_time (staff_id, created_at DESC),
  KEY idx_reviews_dean_time (dean_id, created_at DESC),
  CONSTRAINT fk_reviews_staff FOREIGN KEY (staff_id) REFERENCES users(id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_reviews_dean FOREIGN KEY (dean_id) REFERENCES users(id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT ck_reviews_status CHECK (status IN ('active','withdrawn'))
) ENGINE=InnoDB COMMENT='院长对工作人员的指导意见表';

CREATE TABLE IF NOT EXISTS assistant_sessions (
  id             VARCHAR(64)  NOT NULL COMMENT 'Agent会话编号',
  user_id        VARCHAR(36)  NULL COMMENT '登录用户编号，公开会话可空',
  assistant_role VARCHAR(16)  NOT NULL COMMENT '助手角色：public/guest/staff/dean',
  related_guest_id VARCHAR(36) NULL COMMENT '工作人员场景关联客人',
  mode           VARCHAR(24)  NOT NULL DEFAULT 'safe_guidance' COMMENT '模式：live/safe_guidance',
  model_name     VARCHAR(100) NULL COMMENT '模型名称',
  status         VARCHAR(16)  NOT NULL DEFAULT 'active' COMMENT '状态：active/closed/expired',
  started_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '开始时间',
  last_message_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '最后消息时间',
  expires_at     DATETIME(3)  NULL COMMENT '过期时间',
  PRIMARY KEY (id),
  KEY idx_sessions_user_time (user_id, last_message_at DESC),
  KEY idx_sessions_guest_time (related_guest_id, last_message_at DESC),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT fk_sessions_guest FOREIGN KEY (related_guest_id) REFERENCES users(id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT ck_sessions_role CHECK (assistant_role IN ('public','guest','staff','dean')),
  CONSTRAINT ck_sessions_mode CHECK (mode IN ('live','safe_guidance')),
  CONSTRAINT ck_sessions_status CHECK (status IN ('active','closed','expired'))
) ENGINE=InnoDB COMMENT='Agent会话表';

CREATE TABLE IF NOT EXISTS assistant_messages (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '消息编号',
  session_id     VARCHAR(64)     NOT NULL COMMENT '会话编号',
  user_id        VARCHAR(36)     NULL COMMENT '消息关联用户',
  sender_role    VARCHAR(16)     NOT NULL COMMENT '发送者：user/assistant/system',
  content        TEXT            NOT NULL COMMENT '消息正文',
  content_json   JSON            NULL COMMENT '结构化结果、快捷问题等',
  model_name     VARCHAR(100)    NULL COMMENT '生成模型名称',
  safety_level   VARCHAR(16)     NOT NULL DEFAULT 'normal' COMMENT '安全级别：normal/attention/urgent',
  token_input    INT UNSIGNED    NULL COMMENT '输入Token数',
  token_output   INT UNSIGNED    NULL COMMENT '输出Token数',
  latency_ms     INT UNSIGNED    NULL COMMENT '生成耗时毫秒',
  created_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '消息时间',
  PRIMARY KEY (id),
  KEY idx_messages_session_id (session_id, id),
  KEY idx_messages_user_time (user_id, created_at DESC),
  CONSTRAINT fk_messages_session FOREIGN KEY (session_id) REFERENCES assistant_sessions(id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_messages_user FOREIGN KEY (user_id) REFERENCES users(id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT ck_messages_sender CHECK (sender_role IN ('user','assistant','system')),
  CONSTRAINT ck_messages_safety CHECK (safety_level IN ('normal','attention','urgent'))
) ENGINE=InnoDB COMMENT='Agent对话消息表';

CREATE TABLE IF NOT EXISTS health_intakes (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '健康信息采集编号',
  guest_id         VARCHAR(36)     NOT NULL COMMENT '客人编号',
  session_id       VARCHAR(64)     NULL COMMENT '来源Agent会话',
  raw_content      TEXT            NOT NULL COMMENT '客人原始描述',
  structured_json  JSON            NULL COMMENT '慢病、用药、过敏、睡眠等结构化信息',
  source           VARCHAR(24)     NOT NULL DEFAULT 'assistant' COMMENT '来源：assistant/manual/import',
  risk_level       VARCHAR(16)     NOT NULL DEFAULT 'normal' COMMENT '风险级别：normal/attention/urgent',
  review_status    VARCHAR(24)     NOT NULL DEFAULT 'pending' COMMENT '审核状态：pending/confirmed/rejected',
  reviewed_by      VARCHAR(36)     NULL COMMENT '审核工作人员编号',
  reviewed_at      DATETIME(3)     NULL COMMENT '审核时间',
  review_note      VARCHAR(1000)   NULL COMMENT '审核说明',
  created_at       DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '采集时间',
  updated_at       DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
  PRIMARY KEY (id),
  KEY idx_intakes_guest_status_time (guest_id, review_status, created_at DESC),
  KEY idx_intakes_reviewer_time (reviewed_by, reviewed_at DESC),
  KEY idx_intakes_session (session_id),
  CONSTRAINT fk_intakes_guest FOREIGN KEY (guest_id) REFERENCES users(id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_intakes_session FOREIGN KEY (session_id) REFERENCES assistant_sessions(id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT fk_intakes_reviewer FOREIGN KEY (reviewed_by) REFERENCES users(id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT ck_intakes_source CHECK (source IN ('assistant','manual','import')),
  CONSTRAINT ck_intakes_risk CHECK (risk_level IN ('normal','attention','urgent')),
  CONSTRAINT ck_intakes_review CHECK (review_status IN ('pending','confirmed','rejected'))
) ENGINE=InnoDB COMMENT='Agent采集的客人健康信息待审核表';

SET FOREIGN_KEY_CHECKS = 1;

START TRANSACTION;

INSERT INTO users
  (id, username, password_hash, role, name, phone, status)
VALUES
  ('guest_001', 'guest_demo', 'ab5d05927baf320624d5d18738a00cfc:dacd4d58c8d374ba27ed755fe26c67aef331b611ec22b3286edd61b61dd8576b9b9ea65231153374343fa193002a169a2cb62cd3b994d66aad7fb705577fed97', 'guest', '林海宁', '13800000001', 'active'),
  ('staff_001', 'staff_demo', '619ed152262fb98acd3fa974eab2e2b9:25a9ef83c9ee17e9291b0386242de5e46b95315bf1546540e8418a315bafc1f857f7639e5df437dc657c6dd31f9de41cbbb744ae8316f29d49288c206601d0f6', 'staff', '王医生', '13800000002', 'active'),
  ('dean_001',  'dean_demo',  '387dcf41972303c99f4ab827c6b35e0b:22eae5b6ebde9c79272cfefb78b188a2569d951f9814759ac700d3208299673eb143d5faa46318ac6d0211c994449b11304874ef41f3a6c5e3d8fbce424c0f3f', 'dean', '周院长', '13800000003', 'active')
ON DUPLICATE KEY UPDATE
  name = VALUES(name), phone = VALUES(phone), role = VALUES(role), status = VALUES(status);

INSERT INTO guest_profiles
  (user_id, gender, birth_date, room_no, check_in_date, check_out_date,
   emergency_contact, chronic_json, allergies_json, mobility, service_preferences)
VALUES
  ('guest_001', '女', '1958-06-18', 'A-203', '2026-09-12', '2026-09-26',
   '林先生 13900000001', JSON_ARRAY('高血压'), JSON_ARRAY('虾'), '可独立行走',
   JSON_OBJECT('diet', '低盐', 'activity', '滨海慢行'))
ON DUPLICATE KEY UPDATE
  room_no = VALUES(room_no), check_in_date = VALUES(check_in_date),
  check_out_date = VALUES(check_out_date), updated_at = CURRENT_TIMESTAMP(3);

INSERT INTO staff_guest_assignments
  (id, staff_id, guest_id, start_at, status, created_by)
VALUES
  (1, 'staff_001', 'guest_001', '2026-09-12 08:00:00.000', 'active', 'dean_001')
ON DUPLICATE KEY UPDATE status = VALUES(status), updated_at = CURRENT_TIMESTAMP(3);

INSERT INTO health_records
  (id, guest_id, record_type, value_text, unit, note, source, recorded_at, recorded_by)
VALUES
  (1, 'guest_001', '血压', '138/86', 'mmHg', '晨起测量', 'staff', '2026-09-14 07:30:00.000', 'staff_001')
ON DUPLICATE KEY UPDATE
  value_text = VALUES(value_text), note = VALUES(note), recorded_at = VALUES(recorded_at);

INSERT INTO medical_advice
  (id, guest_id, author_id, title, content, priority, status, source, confirmed_by, confirmed_at)
VALUES
  (1, 'guest_001', 'staff_001', '近期温泉安排',
   '近期血压略高，建议选择低温、短时温泉，单次不超过15分钟；如出现头晕或胸闷请立即停止并联系工作人员。',
   'important', 'active', 'manual', 'staff_001', '2026-09-14 08:00:00.000')
ON DUPLICATE KEY UPDATE
  title = VALUES(title), content = VALUES(content), priority = VALUES(priority), status = VALUES(status);

INSERT INTO news
  (id, category, title, summary, body, status, pinned, author_id, published_at)
VALUES
  (1, '健康管理', '入住后的第一件事：建立自己的康养档案',
   '先完成基础资料与健康状况登记，工作人员会据此安排服务。',
   '欢迎来到海屿康养社区。完整的档案能帮助工作人员了解您的需要，所有信息仅在授权范围内使用。',
   'published', 1, 'dean_001', '2026-09-13 08:00:00.000'),
  (2, '滨海活动', '本周末海风漫步活动开放报名',
   '沿着东湾海岸线慢行90分钟，适合大多数客人。',
   '活动由康养服务团队带队，出发前会根据天气与身体情况进行确认。',
   'published', 0, 'dean_001', '2026-09-12 10:00:00.000'),
  (3, '营养膳食', '秋季海滨膳食菜单更新',
   '低盐、易消化、时令食材，本周已上线。',
   '餐单由营养师与配餐团队共同更新，客人可在个人空间查看适合自己的饮食提醒。',
   'published', 0, 'dean_001', '2026-09-10 09:00:00.000')
ON DUPLICATE KEY UPDATE
  title = VALUES(title), summary = VALUES(summary), body = VALUES(body),
  status = VALUES(status), pinned = VALUES(pinned), published_at = VALUES(published_at);

COMMIT;

SET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS;
SET TIME_ZONE = @OLD_TIME_ZONE;

-- 验收查询：执行结束后应返回 11 张业务表。
SELECT COUNT(*) AS table_count
FROM information_schema.tables
WHERE table_schema = 'haiyu_wellness' AND table_type = 'BASE TABLE';

SELECT table_name, table_comment
FROM information_schema.tables
WHERE table_schema = 'haiyu_wellness' AND table_type = 'BASE TABLE'
ORDER BY table_name;
