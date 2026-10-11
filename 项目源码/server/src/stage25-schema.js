export const sqliteStage25Schema = `
ALTER TABLE wellness_local_notifications RENAME TO wellness_local_notifications_v22;
CREATE TABLE wellness_local_notifications (
  id TEXT PRIMARY KEY,
  guest_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  draft_id TEXT REFERENCES wellness_drafts(id) ON DELETE RESTRICT,
  event_key TEXT NOT NULL UNIQUE,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_url TEXT NOT NULL,
  notification_type TEXT NOT NULL DEFAULT 'update',
  read_at TEXT
);
INSERT INTO wellness_local_notifications
  (id,guest_id,draft_id,event_key,message,created_at,source_type,source_id,target_type,target_id,target_url,notification_type,read_at)
SELECT id,guest_id,draft_id,event_key,message,created_at,'legacy_wellness',event_key,'wellness_draft',draft_id,'schedule','update',NULL
FROM wellness_local_notifications_v22;
DROP TABLE wellness_local_notifications_v22;
CREATE UNIQUE INDEX uq_wellness_notification_guest_source
  ON wellness_local_notifications(guest_id,source_type,source_id);
CREATE INDEX idx_wellness_notifications_guest_created
  ON wellness_local_notifications(guest_id,created_at DESC,id DESC);

CREATE TABLE daily_briefs (
  id TEXT PRIMARY KEY,
  guest_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  business_date TEXT NOT NULL,
  brief_json TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(guest_id,business_date)
);
CREATE INDEX idx_daily_briefs_date ON daily_briefs(business_date,guest_id);

CREATE TABLE care_follow_up_tasks (
  id TEXT PRIMARY KEY,
  guest_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  assignee_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(guest_id,source_type,source_id)
);
CREATE INDEX idx_care_tasks_assignee_status ON care_follow_up_tasks(assignee_id,status,created_at DESC);
`;

export const mysqlStage25Schema = [
  `ALTER TABLE wellness_local_notifications
    MODIFY draft_id VARCHAR(64) NULL,
    ADD COLUMN source_type VARCHAR(40) NOT NULL DEFAULT 'legacy_wellness',
    ADD COLUMN source_id VARCHAR(160) NOT NULL DEFAULT '',
    ADD COLUMN target_type VARCHAR(40) NOT NULL DEFAULT 'wellness_draft',
    ADD COLUMN target_id VARCHAR(160) NOT NULL DEFAULT '',
    ADD COLUMN target_url VARCHAR(80) NOT NULL DEFAULT 'schedule',
    ADD COLUMN notification_type VARCHAR(32) NOT NULL DEFAULT 'update',
    ADD COLUMN read_at DATETIME(3) NULL`,
  `UPDATE wellness_local_notifications SET source_id=event_key,target_id=COALESCE(draft_id,''),
    target_url='schedule' WHERE source_id=''`,
  `ALTER TABLE wellness_local_notifications
    ADD UNIQUE KEY uq_wellness_notification_guest_source(guest_id,source_type,source_id),
    ADD INDEX idx_wellness_notifications_guest_created(guest_id,created_at,id)`,
  `CREATE TABLE daily_briefs (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    guest_id VARCHAR(36) NOT NULL,
    business_date DATE NOT NULL,
    brief_json JSON NOT NULL,
    generated_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uq_daily_brief_guest_date(guest_id,business_date),
    INDEX idx_daily_briefs_date(business_date,guest_id),
    CONSTRAINT fk_daily_brief_guest FOREIGN KEY(guest_id) REFERENCES users(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE care_follow_up_tasks (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    guest_id VARCHAR(36) NOT NULL,
    assignee_id VARCHAR(36) NOT NULL,
    source_type VARCHAR(40) NOT NULL,
    source_id VARCHAR(160) NOT NULL,
    title VARCHAR(180) NOT NULL,
    detail VARCHAR(1200) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'open',
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uq_care_task_guest_source(guest_id,source_type,source_id),
    INDEX idx_care_tasks_assignee_status(assignee_id,status,created_at),
    CONSTRAINT fk_care_task_guest FOREIGN KEY(guest_id) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_care_task_assignee FOREIGN KEY(assignee_id) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT chk_care_task_status CHECK(status IN ('open','done'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`
];
