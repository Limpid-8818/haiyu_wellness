export const sqliteCatalogSchema = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('water_therapy','exercise','seaside')),
  intensity TEXT CHECK (intensity IS NULL OR intensity IN ('low','medium','high')),
  location TEXT NOT NULL,
  description TEXT NOT NULL,
  suitable_people TEXT NOT NULL,
  contraindications TEXT NOT NULL,
  open_windows_json TEXT NOT NULL,
  capacity_per_window INTEGER NOT NULL CHECK (capacity_per_window BETWEEN 1 AND 100),
  sea_entry INTEGER NOT NULL DEFAULT 0 CHECK (sea_entry IN (0,1)),
  outdoor INTEGER NOT NULL DEFAULT 0 CHECK (outdoor IN (0,1)),
  activity_tag TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  is_demo INTEGER NOT NULL DEFAULT 1 CHECK (is_demo IN (0,1)),
  source_reference TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_category_active ON projects(category,active,name);
CREATE TABLE IF NOT EXISTS domain_knowledge (
  knowledge_id TEXT PRIMARY KEY,
  domain TEXT NOT NULL CHECK (domain IN ('therapy','nutrition','exercise','companionship')),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  body TEXT NOT NULL,
  keywords_json TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_checked_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_domain_active ON domain_knowledge(domain,active,title);
CREATE TABLE IF NOT EXISTS safety_rules (
  rule_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  scope TEXT NOT NULL,
  trigger_condition TEXT NOT NULL,
  conditions_json TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('allow','restrict','reject')),
  version TEXT NOT NULL,
  source_reference TEXT NOT NULL,
  source_url TEXT NOT NULL DEFAULT '',
  demo_note TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rules_active_id ON safety_rules(active,rule_id);
`;

export const mysqlCatalogSchema = [
  `CREATE TABLE IF NOT EXISTS projects (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    slug VARCHAR(96) NOT NULL UNIQUE,
    name VARCHAR(120) NOT NULL,
    category VARCHAR(24) NOT NULL,
    intensity VARCHAR(12) NULL,
    location VARCHAR(200) NOT NULL,
    description TEXT NOT NULL,
    suitable_people TEXT NOT NULL,
    contraindications TEXT NOT NULL,
    open_windows_json JSON NOT NULL,
    capacity_per_window INT NOT NULL,
    sea_entry TINYINT(1) NOT NULL DEFAULT 0,
    outdoor TINYINT(1) NOT NULL DEFAULT 0,
    activity_tag VARCHAR(40) NOT NULL,
    active TINYINT(1) NOT NULL DEFAULT 1,
    is_demo TINYINT(1) NOT NULL DEFAULT 1,
    source_reference VARCHAR(600) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    INDEX idx_projects_category_active(category,active,name),
    CONSTRAINT chk_projects_category CHECK (category IN ('water_therapy','exercise','seaside')),
    CONSTRAINT chk_projects_intensity CHECK (intensity IS NULL OR intensity IN ('low','medium','high')),
    CONSTRAINT chk_projects_capacity CHECK (capacity_per_window BETWEEN 1 AND 100),
    CONSTRAINT chk_projects_sea_entry CHECK (sea_entry IN (0,1)),
    CONSTRAINT chk_projects_outdoor CHECK (outdoor IN (0,1)),
    CONSTRAINT chk_projects_active CHECK (active IN (0,1))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS domain_knowledge (
    knowledge_id VARCHAR(64) NOT NULL PRIMARY KEY,
    domain VARCHAR(24) NOT NULL,
    title VARCHAR(180) NOT NULL,
    summary VARCHAR(1000) NOT NULL,
    body TEXT NOT NULL,
    keywords_json JSON NOT NULL,
    source_name VARCHAR(220) NOT NULL,
    source_url VARCHAR(1000) NOT NULL,
    source_checked_at DATETIME(3) NOT NULL,
    active TINYINT(1) NOT NULL DEFAULT 1,
    updated_at DATETIME(3) NOT NULL,
    INDEX idx_knowledge_domain_active(domain,active,title),
    CONSTRAINT chk_knowledge_domain CHECK (domain IN ('therapy','nutrition','exercise','companionship')),
    CONSTRAINT chk_knowledge_active CHECK (active IN (0,1))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS safety_rules (
    rule_id VARCHAR(8) NOT NULL PRIMARY KEY,
    title VARCHAR(180) NOT NULL,
    scope VARCHAR(240) NOT NULL,
    trigger_condition VARCHAR(1200) NOT NULL,
    conditions_json JSON NOT NULL,
    action VARCHAR(16) NOT NULL,
    version VARCHAR(32) NOT NULL,
    source_reference VARCHAR(1000) NOT NULL,
    source_url VARCHAR(1000) NOT NULL DEFAULT '',
    demo_note VARCHAR(1200) NOT NULL,
    active TINYINT(1) NOT NULL DEFAULT 1,
    updated_at DATETIME(3) NOT NULL,
    INDEX idx_rules_active_id(active,rule_id),
    CONSTRAINT chk_rules_action CHECK (action IN ('allow','restrict','reject')),
    CONSTRAINT chk_rules_active CHECK (active IN (0,1))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`
];
