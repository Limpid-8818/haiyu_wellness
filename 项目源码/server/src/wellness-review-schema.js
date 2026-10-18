export const sqliteWellnessReviewSchema = `
ALTER TABLE wellness_drafts ADD COLUMN review_status TEXT NOT NULL DEFAULT 'pending_review';
ALTER TABLE wellness_drafts ADD COLUMN review_thread_id TEXT;
ALTER TABLE wellness_drafts ADD COLUMN supersedes_draft_id TEXT REFERENCES wellness_drafts(id) ON DELETE SET NULL;
ALTER TABLE wellness_drafts ADD COLUMN review_reason TEXT;
ALTER TABLE wellness_drafts ADD COLUMN reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE wellness_drafts ADD COLUMN reviewed_at TEXT;
UPDATE wellness_drafts SET review_thread_id=id WHERE review_thread_id IS NULL;
UPDATE wellness_drafts SET review_status=CASE status WHEN 'active' THEN 'active' WHEN 'cancelled' THEN 'returned' ELSE 'pending_review' END;
ALTER TABLE reservations ADD COLUMN wellness_draft_id TEXT REFERENCES wellness_drafts(id) ON DELETE SET NULL;
ALTER TABLE reservations ADD COLUMN wellness_draft_item_id TEXT REFERENCES wellness_draft_items(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_wellness_drafts_review_queue ON wellness_drafts(review_status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reservations_wellness_draft ON reservations(wellness_draft_id,status);
CREATE TABLE wellness_review_events (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES wellness_drafts(id) ON DELETE RESTRICT,
  review_thread_id TEXT NOT NULL,
  guest_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('clinician','administrator','guest','system')),
  action TEXT NOT NULL CHECK (action IN ('revision','approved','returned','auto_activated','corrected')),
  reason TEXT NOT NULL DEFAULT '',
  from_version INTEGER,
  to_version INTEGER,
  request_key TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(draft_id,actor_id,action,request_key)
);
CREATE INDEX idx_wellness_review_events_guest_time ON wellness_review_events(guest_id,created_at DESC);
CREATE INDEX idx_wellness_review_events_thread ON wellness_review_events(review_thread_id,created_at,id);
CREATE TABLE wellness_admin_attention (
  id TEXT PRIMARY KEY,
  review_thread_id TEXT NOT NULL,
  guest_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  attention_type TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  created_at TEXT NOT NULL,
  UNIQUE(review_thread_id,attention_type)
);
CREATE INDEX idx_wellness_attention_status_time ON wellness_admin_attention(status,created_at DESC);
CREATE TABLE wellness_local_notifications (
  id TEXT PRIMARY KEY,
  guest_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  draft_id TEXT NOT NULL REFERENCES wellness_drafts(id) ON DELETE RESTRICT,
  event_key TEXT NOT NULL UNIQUE,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export const mysqlWellnessReviewSchema = [
  `ALTER TABLE wellness_drafts
    ADD COLUMN review_status VARCHAR(24) NOT NULL DEFAULT 'pending_review',
    ADD COLUMN review_thread_id VARCHAR(64) NULL,
    ADD COLUMN supersedes_draft_id VARCHAR(64) NULL,
    ADD COLUMN review_reason VARCHAR(1200) NULL,
    ADD COLUMN reviewed_by VARCHAR(36) NULL,
    ADD COLUMN reviewed_at DATETIME(3) NULL`,
  `UPDATE wellness_drafts SET review_thread_id=id WHERE review_thread_id IS NULL`,
  `UPDATE wellness_drafts SET review_status=CASE status WHEN 'active' THEN 'active' WHEN 'cancelled' THEN 'returned' ELSE 'pending_review' END`,
  `ALTER TABLE wellness_drafts
    ADD CONSTRAINT fk_wellness_supersedes FOREIGN KEY(supersedes_draft_id) REFERENCES wellness_drafts(id) ON DELETE SET NULL,
    ADD CONSTRAINT fk_wellness_reviewed_by FOREIGN KEY(reviewed_by) REFERENCES users(id) ON DELETE SET NULL,
    ADD INDEX idx_wellness_drafts_review_queue(review_status,created_at)`,
  `ALTER TABLE reservations
    ADD COLUMN wellness_draft_id VARCHAR(64) NULL,
    ADD COLUMN wellness_draft_item_id VARCHAR(64) NULL,
    ADD INDEX idx_reservations_wellness_draft(wellness_draft_id,status),
    ADD CONSTRAINT fk_reservations_wellness_draft FOREIGN KEY(wellness_draft_id) REFERENCES wellness_drafts(id) ON DELETE SET NULL,
    ADD CONSTRAINT fk_reservations_wellness_item FOREIGN KEY(wellness_draft_item_id) REFERENCES wellness_draft_items(id) ON DELETE SET NULL`,
  `CREATE TABLE wellness_review_events (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    draft_id VARCHAR(64) NOT NULL,
    review_thread_id VARCHAR(64) NOT NULL,
    guest_id VARCHAR(36) NOT NULL,
    actor_id VARCHAR(36) NOT NULL,
    actor_role VARCHAR(24) NOT NULL,
    action VARCHAR(24) NOT NULL,
    reason VARCHAR(1200) NOT NULL DEFAULT '',
    from_version INT UNSIGNED NULL,
    to_version INT UNSIGNED NULL,
    request_key VARCHAR(120) NOT NULL,
    payload_json JSON NOT NULL,
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uq_wellness_review_idempotency(draft_id,actor_id,action,request_key),
    INDEX idx_wellness_review_events_guest_time(guest_id,created_at),
    INDEX idx_wellness_review_events_thread(review_thread_id,created_at,id),
    CONSTRAINT fk_wellness_review_event_draft FOREIGN KEY(draft_id) REFERENCES wellness_drafts(id) ON DELETE RESTRICT,
    CONSTRAINT fk_wellness_review_event_guest FOREIGN KEY(guest_id) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_wellness_review_event_actor FOREIGN KEY(actor_id) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT chk_wellness_review_actor CHECK(actor_role IN ('clinician','administrator','guest','system')),
    CONSTRAINT chk_wellness_review_action CHECK(action IN ('revision','approved','returned','auto_activated','corrected'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE wellness_admin_attention (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    review_thread_id VARCHAR(64) NOT NULL,
    guest_id VARCHAR(36) NOT NULL,
    attention_type VARCHAR(48) NOT NULL,
    reason VARCHAR(1200) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'open',
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uq_wellness_attention_thread_type(review_thread_id,attention_type),
    INDEX idx_wellness_attention_status_time(status,created_at),
    CONSTRAINT fk_wellness_attention_guest FOREIGN KEY(guest_id) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT chk_wellness_attention_status CHECK(status IN ('open','resolved'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE wellness_local_notifications (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    guest_id VARCHAR(36) NOT NULL,
    draft_id VARCHAR(64) NOT NULL,
    event_key VARCHAR(160) NOT NULL UNIQUE,
    message VARCHAR(1200) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    INDEX idx_wellness_notifications_guest(guest_id,created_at),
    CONSTRAINT fk_wellness_notification_guest FOREIGN KEY(guest_id) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_wellness_notification_draft FOREIGN KEY(draft_id) REFERENCES wellness_drafts(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`
];
