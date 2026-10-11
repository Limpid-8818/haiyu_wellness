export const sqliteStage26Schema = `
CREATE TABLE IF NOT EXISTS stage26_reservation_checkins (
  id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL UNIQUE REFERENCES reservations(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('attended','no_show')),
  checked_at TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_stage26_checkins_status_time ON stage26_reservation_checkins(status,checked_at);
CREATE TABLE IF NOT EXISTS stage26_weather_batches (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  snapshot_key TEXT NOT NULL,
  source_name TEXT NOT NULL,
  observed_at TEXT,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stage26_weather_batch_items (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES stage26_weather_batches(id) ON DELETE RESTRICT,
  reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE RESTRICT,
  slot_id TEXT NOT NULL REFERENCES activity_slots(id) ON DELETE RESTRICT,
  guest_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE(batch_id,reservation_id)
);
CREATE INDEX IF NOT EXISTS idx_stage26_weather_items_reservation ON stage26_weather_batch_items(reservation_id);
CREATE TABLE IF NOT EXISTS stage26_reschedule_links (
  id TEXT PRIMARY KEY,
  previous_reservation_id TEXT NOT NULL UNIQUE REFERENCES reservations(id) ON DELETE RESTRICT,
  new_reservation_id TEXT NOT NULL UNIQUE REFERENCES reservations(id) ON DELETE RESTRICT,
  actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stage26_staff_slot_assignments (
  id TEXT PRIMARY KEY,
  slot_id TEXT NOT NULL REFERENCES activity_slots(id) ON DELETE RESTRICT,
  staff_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  job_type TEXT NOT NULL CHECK (job_type IN ('coach','therapist','dietitian')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  assigned_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(slot_id,job_type)
);
CREATE INDEX IF NOT EXISTS idx_stage26_staff_schedule ON stage26_staff_slot_assignments(staff_id,status,slot_id);
CREATE TABLE IF NOT EXISTS stage26_provider_events (
  id TEXT PRIMARY KEY,
  supplier_key TEXT NOT NULL,
  feature_key TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('failed','succeeded')),
  error_code TEXT NOT NULL DEFAULT '',
  occurred_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stage26_provider_events_feature_time ON stage26_provider_events(supplier_key,feature_key,occurred_at);
CREATE TABLE IF NOT EXISTS stage26_provider_state (
  supplier_key TEXT NOT NULL,
  feature_key TEXT NOT NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_outcome TEXT NOT NULL CHECK (last_outcome IN ('failed','succeeded')),
  first_failed_at TEXT,
  last_failed_at TEXT,
  last_success_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(supplier_key,feature_key)
);
CREATE TABLE IF NOT EXISTS stage26_operations_incidents (
  supplier_key TEXT NOT NULL,
  feature_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  failure_count INTEGER NOT NULL,
  first_failed_at TEXT NOT NULL,
  last_failed_at TEXT NOT NULL,
  recovered_at TEXT,
  closed_at TEXT,
  closed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  impact_summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(supplier_key,feature_key)
);
CREATE INDEX IF NOT EXISTS idx_stage26_incidents_status_time ON stage26_operations_incidents(status,last_failed_at);
`;

export const mysqlStage26Schema = [
  `CREATE TABLE IF NOT EXISTS stage26_reservation_checkins (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    reservation_id VARCHAR(64) NOT NULL UNIQUE,
    status VARCHAR(16) NOT NULL,
    checked_at DATETIME(3) NOT NULL,
    actor_id VARCHAR(36) NOT NULL,
    note VARCHAR(500) NOT NULL DEFAULT '',
    INDEX idx_stage26_checkins_status_time(status,checked_at),
    CONSTRAINT fk_stage26_checkins_reservation FOREIGN KEY(reservation_id) REFERENCES reservations(id) ON DELETE RESTRICT,
    CONSTRAINT fk_stage26_checkins_actor FOREIGN KEY(actor_id) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT chk_stage26_checkins_status CHECK(status IN ('attended','no_show'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS stage26_weather_batches (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    request_key VARCHAR(120) NOT NULL UNIQUE,
    actor_id VARCHAR(36) NOT NULL,
    snapshot_key VARCHAR(190) NOT NULL,
    source_name VARCHAR(160) NOT NULL,
    observed_at DATETIME(3) NULL,
    reason VARCHAR(500) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    CONSTRAINT fk_stage26_weather_actor FOREIGN KEY(actor_id) REFERENCES users(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS stage26_weather_batch_items (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    batch_id VARCHAR(64) NOT NULL,
    reservation_id VARCHAR(64) NOT NULL,
    slot_id VARCHAR(64) NOT NULL,
    guest_id VARCHAR(36) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uq_stage26_weather_item(batch_id,reservation_id),
    INDEX idx_stage26_weather_items_reservation(reservation_id),
    CONSTRAINT fk_stage26_weather_item_batch FOREIGN KEY(batch_id) REFERENCES stage26_weather_batches(id) ON DELETE RESTRICT,
    CONSTRAINT fk_stage26_weather_item_reservation FOREIGN KEY(reservation_id) REFERENCES reservations(id) ON DELETE RESTRICT,
    CONSTRAINT fk_stage26_weather_item_slot FOREIGN KEY(slot_id) REFERENCES activity_slots(id) ON DELETE RESTRICT,
    CONSTRAINT fk_stage26_weather_item_guest FOREIGN KEY(guest_id) REFERENCES users(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS stage26_reschedule_links (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    previous_reservation_id VARCHAR(64) NOT NULL UNIQUE,
    new_reservation_id VARCHAR(64) NOT NULL UNIQUE,
    actor_id VARCHAR(36) NOT NULL,
    reason VARCHAR(500) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    CONSTRAINT fk_stage26_reschedule_old FOREIGN KEY(previous_reservation_id) REFERENCES reservations(id) ON DELETE RESTRICT,
    CONSTRAINT fk_stage26_reschedule_new FOREIGN KEY(new_reservation_id) REFERENCES reservations(id) ON DELETE RESTRICT,
    CONSTRAINT fk_stage26_reschedule_actor FOREIGN KEY(actor_id) REFERENCES users(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS stage26_staff_slot_assignments (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    slot_id VARCHAR(64) NOT NULL,
    staff_id VARCHAR(36) NOT NULL,
    job_type VARCHAR(24) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'active',
    assigned_by VARCHAR(36) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uq_stage26_slot_job(slot_id,job_type),
    INDEX idx_stage26_staff_schedule(staff_id,status,slot_id),
    CONSTRAINT fk_stage26_assignment_slot FOREIGN KEY(slot_id) REFERENCES activity_slots(id) ON DELETE RESTRICT,
    CONSTRAINT fk_stage26_assignment_staff FOREIGN KEY(staff_id) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_stage26_assignment_actor FOREIGN KEY(assigned_by) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT chk_stage26_assignment_job CHECK(job_type IN ('coach','therapist','dietitian')),
    CONSTRAINT chk_stage26_assignment_status CHECK(status IN ('active','cancelled'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS stage26_provider_events (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    supplier_key VARCHAR(96) NOT NULL,
    feature_key VARCHAR(64) NOT NULL,
    outcome VARCHAR(16) NOT NULL,
    error_code VARCHAR(96) NOT NULL DEFAULT '',
    occurred_at DATETIME(3) NOT NULL,
    INDEX idx_stage26_provider_events_feature_time(supplier_key,feature_key,occurred_at),
    CONSTRAINT chk_stage26_provider_outcome CHECK(outcome IN ('failed','succeeded'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS stage26_provider_state (
    supplier_key VARCHAR(96) NOT NULL,
    feature_key VARCHAR(64) NOT NULL,
    consecutive_failures INT UNSIGNED NOT NULL DEFAULT 0,
    last_outcome VARCHAR(16) NOT NULL,
    first_failed_at DATETIME(3) NULL,
    last_failed_at DATETIME(3) NULL,
    last_success_at DATETIME(3) NULL,
    updated_at DATETIME(3) NOT NULL,
    PRIMARY KEY(supplier_key,feature_key),
    CONSTRAINT chk_stage26_provider_state_outcome CHECK(last_outcome IN ('failed','succeeded'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS stage26_operations_incidents (
    supplier_key VARCHAR(96) NOT NULL,
    feature_key VARCHAR(64) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'open',
    failure_count INT UNSIGNED NOT NULL,
    first_failed_at DATETIME(3) NOT NULL,
    last_failed_at DATETIME(3) NOT NULL,
    recovered_at DATETIME(3) NULL,
    closed_at DATETIME(3) NULL,
    closed_by VARCHAR(36) NULL,
    impact_summary VARCHAR(500) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    PRIMARY KEY(supplier_key,feature_key),
    INDEX idx_stage26_incidents_status_time(status,last_failed_at),
    CONSTRAINT fk_stage26_incident_closed_by FOREIGN KEY(closed_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT chk_stage26_incident_status CHECK(status IN ('open','closed'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`
];
