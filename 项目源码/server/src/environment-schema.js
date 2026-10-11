export const sqliteEnvironmentSchema = `
CREATE TABLE IF NOT EXISTS environment_snapshots (
  snapshot_key TEXT PRIMARY KEY,
  location_id TEXT NOT NULL,
  station_id TEXT NOT NULL DEFAULT '',
  target_date TEXT NOT NULL,
  domain TEXT NOT NULL CHECK(domain IN ('weather','tide','marine')),
  status TEXT NOT NULL CHECK(status IN ('available','demo')),
  source_name TEXT NOT NULL,
  source_url TEXT NOT NULL DEFAULT '',
  observed_at TEXT,
  expires_at TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_environment_location_date ON environment_snapshots(location_id,target_date,domain);
`;

export const mysqlEnvironmentSchema = [
  `CREATE TABLE IF NOT EXISTS environment_snapshots (
    snapshot_key VARCHAR(190) NOT NULL PRIMARY KEY,
    location_id VARCHAR(64) NOT NULL,
    station_id VARCHAR(128) NOT NULL DEFAULT '',
    target_date DATE NOT NULL,
    domain VARCHAR(16) NOT NULL,
    status VARCHAR(16) NOT NULL,
    source_name VARCHAR(160) NOT NULL,
    source_url VARCHAR(1000) NOT NULL DEFAULT '',
    observed_at DATETIME(3) NULL,
    expires_at DATETIME(3) NOT NULL,
    payload_hash CHAR(64) NOT NULL,
    payload_json JSON NOT NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    INDEX idx_environment_location_date(location_id,target_date,domain),
    CONSTRAINT chk_environment_domain CHECK (domain IN ('weather','tide','marine')),
    CONSTRAINT chk_environment_status CHECK (status IN ('available','demo'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`
];
