export const sqliteMoodSchema = `
CREATE TABLE IF NOT EXISTS mood_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guest_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_date TEXT NOT NULL,
  score INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (guest_id, business_date)
);
CREATE INDEX IF NOT EXISTS idx_mood_guest_date ON mood_records(guest_id,business_date DESC,id DESC);
CREATE TABLE IF NOT EXISTS mood_focus_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guest_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL,
  streak_start TEXT NOT NULL,
  streak_end TEXT NOT NULL,
  source_record_ids_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','improved')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE (guest_id, rule_id, streak_start)
);
CREATE INDEX IF NOT EXISTS idx_mood_focus_guest_status ON mood_focus_items(guest_id,status,streak_end DESC);
CREATE TABLE IF NOT EXISTS mood_resource_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guest_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  played_at TEXT NOT NULL,
  UNIQUE (guest_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_mood_usage_guest_resource ON mood_resource_events(guest_id,resource_id,played_at DESC);
`;

export const mysqlMoodSchema = [
  `CREATE TABLE IF NOT EXISTS mood_records (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    guest_id VARCHAR(36) NOT NULL,
    business_date DATE NOT NULL,
    score TINYINT UNSIGNED NOT NULL,
    note VARCHAR(500) NOT NULL DEFAULT '',
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uq_mood_guest_date(guest_id,business_date),
    INDEX idx_mood_guest_date(guest_id,business_date DESC,id DESC),
    CONSTRAINT chk_mood_score CHECK (score BETWEEN 1 AND 5),
    CONSTRAINT fk_mood_guest FOREIGN KEY(guest_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS mood_focus_items (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    guest_id VARCHAR(36) NOT NULL,
    rule_id VARCHAR(64) NOT NULL,
    streak_start DATE NOT NULL,
    streak_end DATE NOT NULL,
    source_record_ids_json TEXT NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'open',
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    resolved_at DATETIME(3) NULL,
    UNIQUE KEY uq_mood_focus_streak(guest_id,rule_id,streak_start),
    INDEX idx_mood_focus_guest_status(guest_id,status,streak_end),
    CONSTRAINT chk_mood_focus_status CHECK (status IN ('open','improved')),
    CONSTRAINT fk_mood_focus_guest FOREIGN KEY(guest_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS mood_resource_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    guest_id VARCHAR(36) NOT NULL,
    resource_id VARCHAR(64) NOT NULL,
    event_id VARCHAR(36) NOT NULL,
    played_at DATETIME(3) NOT NULL,
    UNIQUE KEY uq_mood_resource_event(guest_id,event_id),
    INDEX idx_mood_usage_guest_resource(guest_id,resource_id,played_at),
    CONSTRAINT fk_mood_usage_guest FOREIGN KEY(guest_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`
];
