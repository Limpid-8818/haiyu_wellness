export const sqliteCoreSchema = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('guest','staff','dean')), name TEXT NOT NULL,
  phone TEXT DEFAULT '', avatar TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS guest_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  gender TEXT DEFAULT '', birth_date TEXT DEFAULT '', room_no TEXT DEFAULT '',
  check_in TEXT DEFAULT '', check_out TEXT DEFAULT '', emergency_contact TEXT DEFAULT '',
  chronic_json TEXT NOT NULL DEFAULT '[]', allergies_json TEXT NOT NULL DEFAULT '[]',
  mobility TEXT DEFAULT '', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS staff_guest_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  guest_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_at TEXT NOT NULL, end_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK (end_at IS NULL OR end_at >= start_at), UNIQUE (staff_id, guest_id, start_at)
);
CREATE INDEX IF NOT EXISTS idx_assignment_staff_status ON staff_guest_assignments(staff_id, status);
CREATE INDEX IF NOT EXISTS idx_assignment_guest_status ON staff_guest_assignments(guest_id, status);
CREATE TABLE IF NOT EXISTS health_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT, guest_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  record_type TEXT NOT NULL, value TEXT NOT NULL, unit TEXT DEFAULT '', note TEXT DEFAULT '',
  recorded_at TEXT NOT NULL, recorded_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS medical_advice (
  id INTEGER PRIMARY KEY AUTOINCREMENT, guest_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, content TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','important','urgent')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS news (
  id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL, title TEXT NOT NULL,
  summary TEXT NOT NULL, body TEXT NOT NULL, cover TEXT DEFAULT '', published_at TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, action TEXT NOT NULL,
  target_type TEXT DEFAULT '', target_id TEXT DEFAULT '', detail TEXT DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS staff_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT, staff_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dean_id TEXT NOT NULL REFERENCES users(id), content TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assistant_sessions (
  id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  assistant_role TEXT NOT NULL CHECK (assistant_role IN ('public','guest','staff','dean')),
  related_guest_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed','expired')),
  started_at TEXT NOT NULL, last_message_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_time ON assistant_sessions(user_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_guest_time ON assistant_sessions(related_guest_id, last_message_at DESC);
CREATE TABLE IF NOT EXISTS assistant_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
  user_id TEXT, role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session_id ON assistant_messages(session_id, id);
CREATE TABLE IF NOT EXISTS health_intakes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, guest_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES assistant_sessions(id) ON DELETE SET NULL,
  content TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'assistant', created_at TEXT NOT NULL
);
`;

export const businessTables = [
  'users', 'guest_profiles', 'staff_guest_assignments', 'health_records', 'medical_advice',
  'news', 'audit_logs', 'staff_reviews', 'assistant_sessions', 'assistant_messages', 'health_intakes',
  'activity_slots', 'reservations', 'meal_menus', 'meal_menu_items', 'meal_orders', 'meal_order_requests',
  'mood_records', 'mood_focus_items', 'mood_resource_events'
];

export const mysqlCoreSchema = [
  `CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(36) PRIMARY KEY, username VARCHAR(64) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL, role VARCHAR(16) NOT NULL,
    name VARCHAR(64) NOT NULL, phone VARCHAR(32) NOT NULL DEFAULT '',
    avatar_url VARCHAR(500) NOT NULL DEFAULT '', status VARCHAR(16) NOT NULL DEFAULT 'active',
    last_login_at DATETIME(3) NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    CONSTRAINT chk_users_role CHECK (role IN ('guest','staff','dean')),
    CONSTRAINT chk_users_status CHECK (status IN ('active','disabled','locked'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS guest_profiles (
    user_id VARCHAR(36) PRIMARY KEY, gender VARCHAR(16) NULL, birth_date DATE NULL,
    room_no VARCHAR(32) NULL, check_in_date DATE NULL, check_out_date DATE NULL,
    emergency_contact VARCHAR(128) NULL, chronic_json JSON NOT NULL, allergies_json JSON NOT NULL,
    mobility VARCHAR(128) NULL, service_preferences JSON NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    INDEX idx_guest_profiles_room(room_no), INDEX idx_guest_profiles_check_in(check_in_date),
    INDEX idx_guest_profiles_check_out(check_out_date),
    CONSTRAINT fk_guest_profiles_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT chk_guest_profiles_dates CHECK (check_out_date IS NULL OR check_in_date IS NULL OR check_out_date >= check_in_date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS staff_guest_assignments (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    staff_id VARCHAR(36) NOT NULL, guest_id VARCHAR(36) NOT NULL,
    start_at DATETIME(3) NOT NULL, end_at DATETIME(3) NULL, status VARCHAR(16) NOT NULL DEFAULT 'active',
    created_by VARCHAR(36) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_assignment_start(staff_id,guest_id,start_at), INDEX idx_assignment_staff_status(staff_id,status),
    INDEX idx_assignment_guest_status(guest_id,status),
    CONSTRAINT fk_assignment_staff FOREIGN KEY(staff_id) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_assignment_guest FOREIGN KEY(guest_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_assignment_creator FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT chk_assignment_status CHECK (status IN ('active','closed')),
    CONSTRAINT chk_assignment_dates CHECK (end_at IS NULL OR end_at >= start_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS health_records (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, guest_id VARCHAR(36) NOT NULL,
    record_type VARCHAR(64) NOT NULL, value_text VARCHAR(128) NOT NULL, unit VARCHAR(32) NULL,
    note VARCHAR(1000) NULL, source VARCHAR(24) NOT NULL DEFAULT 'staff', recorded_at DATETIME(3) NOT NULL,
    recorded_by VARCHAR(36) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX idx_health_guest(guest_id), INDEX idx_health_type(record_type), INDEX idx_health_recorded(recorded_at),
    INDEX idx_health_recorder(recorded_by),
    CONSTRAINT fk_health_guest FOREIGN KEY(guest_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_health_recorder FOREIGN KEY(recorded_by) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT chk_health_source CHECK (source IN ('guest','staff','device','assistant','import'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS medical_advice (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, guest_id VARCHAR(36) NOT NULL,
    author_id VARCHAR(36) NOT NULL, title VARCHAR(200) NOT NULL, content TEXT NOT NULL,
    priority VARCHAR(16) NOT NULL DEFAULT 'normal', status VARCHAR(16) NOT NULL DEFAULT 'active',
    source VARCHAR(24) NOT NULL DEFAULT 'manual', confirmed_by VARCHAR(36) NULL,
    confirmed_at DATETIME(3) NULL, closed_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    INDEX idx_advice_guest(guest_id), INDEX idx_advice_author(author_id), INDEX idx_advice_status(status), INDEX idx_advice_created(created_at),
    CONSTRAINT fk_advice_guest FOREIGN KEY(guest_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_advice_author FOREIGN KEY(author_id) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_advice_confirmer FOREIGN KEY(confirmed_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT chk_advice_priority CHECK (priority IN ('normal','important','urgent')),
    CONSTRAINT chk_advice_status CHECK (status IN ('draft','active','closed','revoked')),
    CONSTRAINT chk_advice_source CHECK (source IN ('manual','assistant_draft'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS news (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, category VARCHAR(64) NOT NULL,
    title VARCHAR(200) NOT NULL, summary VARCHAR(500) NOT NULL, body LONGTEXT NOT NULL,
    cover_url VARCHAR(500) NULL, status VARCHAR(16) NOT NULL DEFAULT 'published', pinned TINYINT(1) NOT NULL DEFAULT 0,
    author_id VARCHAR(36) NULL, published_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    INDEX idx_news_status(status), INDEX idx_news_pinned(pinned), INDEX idx_news_published(published_at),
    CONSTRAINT fk_news_author FOREIGN KEY(author_id) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT chk_news_status CHECK (status IN ('draft','published','archived')),
    CONSTRAINT chk_news_pinned CHECK (pinned IN (0,1))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, actor_id VARCHAR(36) NULL,
    action VARCHAR(100) NOT NULL, target_type VARCHAR(64) NULL, target_id VARCHAR(64) NULL,
    detail_json JSON NULL, request_id VARCHAR(64) NULL, ip_address VARCHAR(45) NULL,
    user_agent VARCHAR(500) NULL, result VARCHAR(16) NOT NULL DEFAULT 'success',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX idx_audit_actor(actor_id), INDEX idx_audit_action(action), INDEX idx_audit_target_type(target_type),
    INDEX idx_audit_target_id(target_id), INDEX idx_audit_request(request_id), INDEX idx_audit_created(created_at),
    CONSTRAINT fk_audit_actor FOREIGN KEY(actor_id) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT chk_audit_result CHECK (result IN ('success','failure','denied'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS staff_reviews (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, staff_id VARCHAR(36) NOT NULL,
    dean_id VARCHAR(36) NOT NULL, content TEXT NOT NULL, status VARCHAR(16) NOT NULL DEFAULT 'active',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    INDEX idx_reviews_staff(staff_id), INDEX idx_reviews_dean(dean_id), INDEX idx_reviews_created(created_at),
    CONSTRAINT fk_reviews_staff FOREIGN KEY(staff_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_reviews_dean FOREIGN KEY(dean_id) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT chk_reviews_status CHECK (status IN ('active','withdrawn'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS assistant_sessions (
    id VARCHAR(64) NOT NULL PRIMARY KEY, user_id VARCHAR(36) NULL,
    assistant_role VARCHAR(16) NOT NULL, related_guest_id VARCHAR(36) NULL,
    mode VARCHAR(24) NOT NULL DEFAULT 'safe_guidance', model_name VARCHAR(100) NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'active', started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    last_message_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), expires_at DATETIME(3) NULL,
    INDEX idx_sessions_user_time(user_id,last_message_at), INDEX idx_sessions_guest_time(related_guest_id,last_message_at),
    CONSTRAINT fk_sessions_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_sessions_guest FOREIGN KEY(related_guest_id) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT chk_sessions_role CHECK (assistant_role IN ('public','guest','staff','dean')),
    CONSTRAINT chk_sessions_mode CHECK (mode IN ('live','safe_guidance')),
    CONSTRAINT chk_sessions_status CHECK (status IN ('active','closed','expired'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS assistant_messages (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, session_id VARCHAR(64) NOT NULL,
    user_id VARCHAR(36) NULL, sender_role VARCHAR(16) NOT NULL, content TEXT NOT NULL,
    content_json JSON NULL, model_name VARCHAR(100) NULL, safety_level VARCHAR(16) NOT NULL DEFAULT 'normal',
    token_input INT UNSIGNED NULL, token_output INT UNSIGNED NULL, latency_ms INT UNSIGNED NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX idx_messages_session_id(session_id,id), INDEX idx_messages_user(user_id), INDEX idx_messages_created(created_at),
    CONSTRAINT fk_messages_session FOREIGN KEY(session_id) REFERENCES assistant_sessions(id) ON DELETE CASCADE,
    CONSTRAINT fk_messages_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT chk_messages_role CHECK (sender_role IN ('user','assistant','system')),
    CONSTRAINT chk_messages_safety CHECK (safety_level IN ('normal','attention','urgent'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS health_intakes (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, guest_id VARCHAR(36) NOT NULL,
    session_id VARCHAR(64) NULL, raw_content TEXT NOT NULL, structured_json JSON NULL,
    source VARCHAR(24) NOT NULL DEFAULT 'assistant', risk_level VARCHAR(16) NOT NULL DEFAULT 'normal',
    reviewed_by VARCHAR(36) NULL, reviewed_at DATETIME(3) NULL, review_note VARCHAR(1000) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    INDEX idx_intakes_guest(guest_id), INDEX idx_intakes_session(session_id), INDEX idx_intakes_reviewed_by(reviewed_by),
    INDEX idx_intakes_reviewed_at(reviewed_at), INDEX idx_intakes_created(created_at),
    CONSTRAINT fk_intakes_guest FOREIGN KEY(guest_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_intakes_session FOREIGN KEY(session_id) REFERENCES assistant_sessions(id) ON DELETE SET NULL,
    CONSTRAINT fk_intakes_reviewer FOREIGN KEY(reviewed_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT chk_intakes_source CHECK (source IN ('assistant','manual','import')),
    CONSTRAINT chk_intakes_risk CHECK (risk_level IN ('normal','attention','urgent'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`
];
