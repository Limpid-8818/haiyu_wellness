export const sqliteServiceSchema = `CREATE TABLE IF NOT EXISTS service_executions (
  id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE RESTRICT,
  job_type TEXT NOT NULL CHECK(job_type IN ('coach','therapist')),
  status TEXT NOT NULL CHECK(status IN ('completed','no_show')),
  actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  note TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(reservation_id,job_type)
);`;
export const mysqlServiceSchema = `CREATE TABLE IF NOT EXISTS service_executions (
  id VARCHAR(64) PRIMARY KEY, reservation_id VARCHAR(64) NOT NULL,
  job_type VARCHAR(24) NOT NULL, status VARCHAR(16) NOT NULL,
  actor_id VARCHAR(36) NOT NULL, note VARCHAR(500) NOT NULL, created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_service_reservation_job(reservation_id,job_type),
  FOREIGN KEY(reservation_id) REFERENCES reservations(id) ON DELETE RESTRICT,
  FOREIGN KEY(actor_id) REFERENCES users(id) ON DELETE RESTRICT,
  CHECK(job_type IN ('coach','therapist')), CHECK(status IN ('completed','no_show'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`;
