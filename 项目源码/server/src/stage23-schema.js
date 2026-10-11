export const sqliteStage23Schema = `
CREATE TABLE IF NOT EXISTS assistant_action_cards (
  id TEXT PRIMARY KEY,
  logical_action_id TEXT NOT NULL,
  parent_card_id TEXT REFERENCES assistant_action_cards(id) ON DELETE SET NULL,
  guest_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL REFERENCES assistant_sessions(id) ON DELETE CASCADE,
  source_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL CHECK (action_type IN ('book_program','cancel_booking','book_meal','swap_dish','record_metric','rest_change')),
  version INTEGER NOT NULL CHECK (version >= 1),
  status TEXT NOT NULL CHECK (status IN ('needs_input','pending_confirmation','confirmed','stale','expired','rejected','superseded','failed')),
  parameters_json TEXT NOT NULL,
  impact_json TEXT NOT NULL,
  missing_fields_json TEXT NOT NULL DEFAULT '[]',
  basis_json TEXT NOT NULL DEFAULT '{}',
  request_fingerprint TEXT NOT NULL,
  result_json TEXT,
  error_code TEXT,
  expires_at TEXT,
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(logical_action_id, version)
);
CREATE INDEX IF NOT EXISTS idx_assistant_actions_session_status ON assistant_action_cards(session_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assistant_actions_run ON assistant_action_cards(source_run_id,id);
CREATE INDEX IF NOT EXISTS idx_assistant_actions_guest_session ON assistant_action_cards(guest_id,session_id,created_at DESC);
`;

export const mysqlStage23Schema = [
  `CREATE TABLE IF NOT EXISTS assistant_action_cards (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    logical_action_id VARCHAR(64) NOT NULL,
    parent_card_id VARCHAR(64) NULL,
    guest_id VARCHAR(36) NOT NULL,
    session_id VARCHAR(64) NOT NULL,
    source_run_id VARCHAR(64) NOT NULL,
    action_type VARCHAR(32) NOT NULL,
    version INT UNSIGNED NOT NULL,
    status VARCHAR(24) NOT NULL,
    parameters_json JSON NOT NULL,
    impact_json JSON NOT NULL,
    missing_fields_json JSON NOT NULL,
    basis_json JSON NOT NULL,
    request_fingerprint CHAR(64) NOT NULL,
    result_json JSON NULL,
    error_code VARCHAR(64) NULL,
    expires_at DATETIME(3) NULL,
    confirmed_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uq_assistant_action_version(logical_action_id,version),
    INDEX idx_assistant_actions_session_status(session_id,status,created_at),
    INDEX idx_assistant_actions_run(source_run_id,id),
    INDEX idx_assistant_actions_guest_session(guest_id,session_id,created_at),
    CONSTRAINT fk_assistant_action_parent FOREIGN KEY(parent_card_id) REFERENCES assistant_action_cards(id) ON DELETE SET NULL,
    CONSTRAINT fk_assistant_action_guest FOREIGN KEY(guest_id) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_assistant_action_session FOREIGN KEY(session_id) REFERENCES assistant_sessions(id) ON DELETE CASCADE,
    CONSTRAINT fk_assistant_action_run FOREIGN KEY(source_run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
    CONSTRAINT chk_assistant_action_type CHECK(action_type IN ('book_program','cancel_booking','book_meal','swap_dish','record_metric','rest_change')),
    CONSTRAINT chk_assistant_action_status CHECK(status IN ('needs_input','pending_confirmation','confirmed','stale','expired','rejected','superseded','failed')),
    CONSTRAINT chk_assistant_action_version CHECK(version >= 1)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`
];
