export const sqliteBookingSchema = `
CREATE TABLE IF NOT EXISTS activity_slots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  business_date TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  local_start TEXT NOT NULL,
  local_end TEXT NOT NULL,
  capacity INTEGER NOT NULL CHECK (capacity BETWEEN 1 AND 100),
  is_closed INTEGER NOT NULL DEFAULT 0 CHECK (is_closed IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (ends_at > starts_at),
  UNIQUE(project_id,business_date,local_start,local_end)
);
CREATE INDEX IF NOT EXISTS idx_activity_slots_project_date ON activity_slots(project_id,business_date,starts_at);
CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY,
  guest_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  slot_id TEXT NOT NULL REFERENCES activity_slots(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('confirmed','cancelled')),
  created_at TEXT NOT NULL,
  cancelled_at TEXT,
  cancellation_reason TEXT,
  environment_snapshot_id TEXT NOT NULL,
  availability_status TEXT NOT NULL,
  availability_reason TEXT NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 1 CHECK (is_demo IN (0,1)),
  UNIQUE(guest_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_reservations_slot_status ON reservations(slot_id,status);
CREATE INDEX IF NOT EXISTS idx_reservations_guest_status_created ON reservations(guest_id,status,created_at);
`;

export const mysqlBookingSchema = [
  `CREATE TABLE IF NOT EXISTS activity_slots (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    project_id VARCHAR(64) NOT NULL,
    business_date DATE NOT NULL,
    starts_at DATETIME(3) NOT NULL,
    ends_at DATETIME(3) NOT NULL,
    local_start CHAR(5) NOT NULL,
    local_end CHAR(5) NOT NULL,
    capacity INT UNSIGNED NOT NULL,
    is_closed TINYINT(1) NOT NULL DEFAULT 0,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uq_activity_slots_project_window(project_id,business_date,local_start,local_end),
    INDEX idx_activity_slots_project_date(project_id,business_date,starts_at),
    CONSTRAINT fk_activity_slots_project FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE RESTRICT,
    CONSTRAINT chk_activity_slots_capacity CHECK (capacity BETWEEN 1 AND 100),
    CONSTRAINT chk_activity_slots_closed CHECK (is_closed IN (0,1)),
    CONSTRAINT chk_activity_slots_interval CHECK (ends_at > starts_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS reservations (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    guest_id VARCHAR(36) NOT NULL,
    slot_id VARCHAR(64) NOT NULL,
    idempotency_key VARCHAR(120) NOT NULL,
    request_fingerprint CHAR(64) NOT NULL,
    status VARCHAR(16) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    cancelled_at DATETIME(3) NULL,
    cancellation_reason VARCHAR(240) NULL,
    environment_snapshot_id VARCHAR(255) NOT NULL,
    availability_status VARCHAR(16) NOT NULL,
    availability_reason VARCHAR(1200) NOT NULL,
    is_demo TINYINT(1) NOT NULL DEFAULT 1,
    UNIQUE KEY uq_reservations_guest_idempotency(guest_id,idempotency_key),
    INDEX idx_reservations_slot_status(slot_id,status),
    INDEX idx_reservations_guest_status_created(guest_id,status,created_at),
    CONSTRAINT fk_reservations_guest FOREIGN KEY(guest_id) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_reservations_slot FOREIGN KEY(slot_id) REFERENCES activity_slots(id) ON DELETE RESTRICT,
    CONSTRAINT chk_reservations_status CHECK (status IN ('confirmed','cancelled')),
    CONSTRAINT chk_reservations_availability CHECK (availability_status IN ('available','pending','restricted')),
    CONSTRAINT chk_reservations_demo CHECK (is_demo IN (0,1))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`
];
