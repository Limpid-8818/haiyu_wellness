export const sqliteStage24Schema = `
CREATE TABLE IF NOT EXISTS wellness_checkins (
  id TEXT PRIMARY KEY,
  guest_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reservation_id TEXT NOT NULL UNIQUE REFERENCES reservations(id) ON DELETE RESTRICT,
  business_date TEXT NOT NULL,
  checked_in_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wellness_checkins_guest_date ON wellness_checkins(guest_id,business_date DESC,checked_in_at DESC);

CREATE TABLE IF NOT EXISTS wellness_feedback (
  id TEXT PRIMARY KEY,
  guest_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reservation_id TEXT NOT NULL UNIQUE REFERENCES reservations(id) ON DELETE RESTRICT,
  checkin_id TEXT NOT NULL UNIQUE REFERENCES wellness_checkins(id) ON DELETE RESTRICT,
  feeling TEXT NOT NULL CHECK (feeling IN ('comfortable','general','uncomfortable')),
  note TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  business_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wellness_feedback_guest_date ON wellness_feedback(guest_id,business_date DESC,updated_at DESC);

CREATE TABLE IF NOT EXISTS wellness_feedback_revisions (
  id TEXT PRIMARY KEY,
  feedback_id TEXT NOT NULL REFERENCES wellness_feedback(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  feeling TEXT NOT NULL CHECK (feeling IN ('comfortable','general','uncomfortable')),
  note TEXT NOT NULL DEFAULT '',
  business_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(feedback_id,revision)
);
CREATE INDEX IF NOT EXISTS idx_wellness_feedback_revisions_feedback ON wellness_feedback_revisions(feedback_id,revision DESC);

CREATE TABLE IF NOT EXISTS wellness_replan_events (
  id TEXT PRIMARY KEY,
  guest_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  source_type TEXT NOT NULL CHECK (source_type IN ('feedback','health_metric','mood')),
  source_id TEXT NOT NULL,
  source_version INTEGER NOT NULL CHECK (source_version >= 1),
  source_label TEXT NOT NULL,
  source_snapshot_json TEXT NOT NULL,
  trigger_reason TEXT NOT NULL DEFAULT '',
  requires_attention INTEGER NOT NULL DEFAULT 0 CHECK (requires_attention IN (0,1)),
  status TEXT NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','evaluating','pending_review','active','failed')),
  baseline_draft_id TEXT REFERENCES wellness_drafts(id) ON DELETE SET NULL,
  candidate_draft_id TEXT REFERENCES wellness_drafts(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(guest_id,source_type,source_id,source_version)
);
CREATE INDEX IF NOT EXISTS idx_wellness_replan_guest_time ON wellness_replan_events(guest_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_wellness_replan_candidate ON wellness_replan_events(candidate_draft_id);
`;

export const mysqlStage24Schema = [
  `CREATE TABLE IF NOT EXISTS wellness_checkins (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    guest_id VARCHAR(36) NOT NULL,
    reservation_id VARCHAR(64) NOT NULL,
    business_date DATE NOT NULL,
    checked_in_at DATETIME(3) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uq_wellness_checkins_reservation(reservation_id),
    INDEX idx_wellness_checkins_guest_date(guest_id,business_date,checked_in_at),
    CONSTRAINT fk_wellness_checkins_guest FOREIGN KEY(guest_id) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_wellness_checkins_reservation FOREIGN KEY(reservation_id) REFERENCES reservations(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS wellness_feedback (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    guest_id VARCHAR(36) NOT NULL,
    reservation_id VARCHAR(64) NOT NULL,
    checkin_id VARCHAR(64) NOT NULL,
    feeling VARCHAR(24) NOT NULL,
    note VARCHAR(500) NOT NULL DEFAULT '',
    revision INT UNSIGNED NOT NULL DEFAULT 1,
    business_date DATE NOT NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uq_wellness_feedback_reservation(reservation_id),
    UNIQUE KEY uq_wellness_feedback_checkin(checkin_id),
    INDEX idx_wellness_feedback_guest_date(guest_id,business_date,updated_at),
    CONSTRAINT fk_wellness_feedback_guest FOREIGN KEY(guest_id) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_wellness_feedback_reservation FOREIGN KEY(reservation_id) REFERENCES reservations(id) ON DELETE RESTRICT,
    CONSTRAINT fk_wellness_feedback_checkin FOREIGN KEY(checkin_id) REFERENCES wellness_checkins(id) ON DELETE RESTRICT,
    CONSTRAINT chk_wellness_feedback_feeling CHECK(feeling IN ('comfortable','general','uncomfortable')),
    CONSTRAINT chk_wellness_feedback_revision CHECK(revision >= 1)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS wellness_feedback_revisions (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    feedback_id VARCHAR(64) NOT NULL,
    revision INT UNSIGNED NOT NULL,
    feeling VARCHAR(24) NOT NULL,
    note VARCHAR(500) NOT NULL DEFAULT '',
    business_date DATE NOT NULL,
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uq_wellness_feedback_revision(feedback_id,revision),
    INDEX idx_wellness_feedback_revisions_feedback(feedback_id,revision),
    CONSTRAINT fk_wellness_feedback_revision FOREIGN KEY(feedback_id) REFERENCES wellness_feedback(id) ON DELETE CASCADE,
    CONSTRAINT chk_wellness_feedback_revision_feeling CHECK(feeling IN ('comfortable','general','uncomfortable')),
    CONSTRAINT chk_wellness_feedback_revision_number CHECK(revision >= 1)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS wellness_replan_events (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    guest_id VARCHAR(36) NOT NULL,
    source_type VARCHAR(24) NOT NULL,
    source_id VARCHAR(64) NOT NULL,
    source_version INT UNSIGNED NOT NULL,
    source_label VARCHAR(256) NOT NULL,
    source_snapshot_json JSON NOT NULL,
    trigger_reason VARCHAR(1000) NOT NULL DEFAULT '',
    requires_attention TINYINT(1) NOT NULL DEFAULT 0,
    status VARCHAR(24) NOT NULL DEFAULT 'recorded',
    baseline_draft_id VARCHAR(64) NULL,
    candidate_draft_id VARCHAR(64) NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uq_wellness_replan_source(guest_id,source_type,source_id,source_version),
    INDEX idx_wellness_replan_guest_time(guest_id,created_at,id),
    INDEX idx_wellness_replan_candidate(candidate_draft_id),
    CONSTRAINT fk_wellness_replan_guest FOREIGN KEY(guest_id) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_wellness_replan_baseline FOREIGN KEY(baseline_draft_id) REFERENCES wellness_drafts(id) ON DELETE SET NULL,
    CONSTRAINT fk_wellness_replan_draft FOREIGN KEY(candidate_draft_id) REFERENCES wellness_drafts(id) ON DELETE SET NULL,
    CONSTRAINT chk_wellness_replan_source_type CHECK(source_type IN ('feedback','health_metric','mood')),
    CONSTRAINT chk_wellness_replan_source_version CHECK(source_version >= 1),
    CONSTRAINT chk_wellness_replan_attention CHECK(requires_attention IN (0,1)),
    CONSTRAINT chk_wellness_replan_status CHECK(status IN ('recorded','evaluating','pending_review','active','failed'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`
];
