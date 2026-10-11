export const sqliteMealSchema = `
CREATE TABLE IF NOT EXISTS dishes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ingredients_json TEXT NOT NULL,
  allergens_json TEXT NOT NULL,
  dietary_tags_json TEXT NOT NULL,
  audience_tags_json TEXT NOT NULL,
  meal_types_json TEXT NOT NULL,
  slot TEXT NOT NULL CHECK (slot IN ('main','side','soup')),
  nutrition_labels_json TEXT NOT NULL,
  source_reference TEXT NOT NULL,
  supply_status TEXT NOT NULL CHECK (supply_status IN ('demo_available','unavailable','unknown')),
  non_seafood_alternative_id TEXT REFERENCES dishes(id) ON DELETE SET NULL,
  is_demo INTEGER NOT NULL DEFAULT 1 CHECK (is_demo IN (0,1))
);
CREATE INDEX IF NOT EXISTS idx_dishes_meal_slot_supply ON dishes(slot,supply_status);
CREATE TABLE IF NOT EXISTS meal_menus (
  id TEXT PRIMARY KEY,
  guest_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  business_date TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  status TEXT NOT NULL CHECK (status IN ('ready','incomplete')),
  rule_basis_json TEXT NOT NULL,
  avoided_items_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(guest_id,business_date)
);
CREATE INDEX IF NOT EXISTS idx_meal_menus_guest_date ON meal_menus(guest_id,business_date);
CREATE TABLE IF NOT EXISTS meal_menu_items (
  id TEXT PRIMARY KEY,
  menu_id TEXT NOT NULL REFERENCES meal_menus(id) ON DELETE CASCADE,
  meal_type TEXT NOT NULL CHECK (meal_type IN ('breakfast','lunch','dinner')),
  slot TEXT NOT NULL CHECK (slot IN ('main','side','soup')),
  dish_id TEXT REFERENCES dishes(id) ON DELETE RESTRICT,
  dish_snapshot_json TEXT NOT NULL,
  selection_reason TEXT NOT NULL DEFAULT '',
  UNIQUE(menu_id,meal_type,slot)
);
CREATE INDEX IF NOT EXISTS idx_meal_menu_items_menu ON meal_menu_items(menu_id,meal_type,slot);
CREATE TABLE IF NOT EXISTS meal_orders (
  id TEXT PRIMARY KEY,
  guest_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  menu_id TEXT NOT NULL REFERENCES meal_menus(id) ON DELETE RESTRICT,
  business_date TEXT NOT NULL,
  meal_type TEXT NOT NULL CHECK (meal_type IN ('breakfast','lunch','dinner')),
  menu_version INTEGER NOT NULL,
  request_fingerprint TEXT NOT NULL,
  dishes_snapshot_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved','preparing','delivered')),
  created_at TEXT NOT NULL,
  expected_delivery_at TEXT NOT NULL,
  expected_time_is_demo INTEGER NOT NULL DEFAULT 1 CHECK (expected_time_is_demo IN (0,1)),
  preparing_at TEXT,
  delivered_at TEXT,
  UNIQUE(guest_id,business_date,meal_type)
);
CREATE INDEX IF NOT EXISTS idx_meal_orders_date_meal_status ON meal_orders(business_date,meal_type,status);
CREATE INDEX IF NOT EXISTS idx_meal_orders_guest_date ON meal_orders(guest_id,business_date,meal_type);
CREATE TABLE IF NOT EXISTS meal_order_requests (
  guest_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  order_id TEXT NOT NULL REFERENCES meal_orders(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(guest_id,idempotency_key)
);
`;

export const mysqlMealSchema = [
  `CREATE TABLE IF NOT EXISTS dishes (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    name VARCHAR(160) NOT NULL,
    ingredients_json JSON NOT NULL,
    allergens_json JSON NOT NULL,
    dietary_tags_json JSON NOT NULL,
    audience_tags_json JSON NOT NULL,
    meal_types_json JSON NOT NULL,
    slot VARCHAR(16) NOT NULL,
    nutrition_labels_json JSON NOT NULL,
    source_reference VARCHAR(500) NOT NULL,
    supply_status VARCHAR(24) NOT NULL,
    non_seafood_alternative_id VARCHAR(64) NULL,
    is_demo TINYINT(1) NOT NULL DEFAULT 1,
    INDEX idx_dishes_meal_slot_supply(slot,supply_status),
    CONSTRAINT fk_dishes_seafood_alternative FOREIGN KEY(non_seafood_alternative_id) REFERENCES dishes(id) ON DELETE SET NULL,
    CONSTRAINT chk_dishes_slot CHECK (slot IN ('main','side','soup')),
    CONSTRAINT chk_dishes_supply CHECK (supply_status IN ('demo_available','unavailable','unknown')),
    CONSTRAINT chk_dishes_demo CHECK (is_demo IN (0,1))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS meal_menus (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    guest_id VARCHAR(36) NOT NULL,
    business_date DATE NOT NULL,
    version INT UNSIGNED NOT NULL,
    status VARCHAR(16) NOT NULL,
    rule_basis_json JSON NOT NULL,
    avoided_items_json JSON NOT NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uq_meal_menu_guest_date(guest_id,business_date),
    INDEX idx_meal_menus_guest_date(guest_id,business_date),
    CONSTRAINT fk_meal_menus_guest FOREIGN KEY(guest_id) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT chk_meal_menus_version CHECK (version >= 1),
    CONSTRAINT chk_meal_menus_status CHECK (status IN ('ready','incomplete'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS meal_menu_items (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    menu_id VARCHAR(64) NOT NULL,
    meal_type VARCHAR(16) NOT NULL,
    slot VARCHAR(16) NOT NULL,
    dish_id VARCHAR(64) NULL,
    dish_snapshot_json JSON NOT NULL,
    selection_reason VARCHAR(500) NOT NULL DEFAULT '',
    UNIQUE KEY uq_meal_menu_slot(menu_id,meal_type,slot),
    INDEX idx_meal_menu_items_menu(menu_id,meal_type,slot),
    CONSTRAINT fk_meal_items_menu FOREIGN KEY(menu_id) REFERENCES meal_menus(id) ON DELETE CASCADE,
    CONSTRAINT fk_meal_items_dish FOREIGN KEY(dish_id) REFERENCES dishes(id) ON DELETE RESTRICT,
    CONSTRAINT chk_meal_items_type CHECK (meal_type IN ('breakfast','lunch','dinner')),
    CONSTRAINT chk_meal_items_slot CHECK (slot IN ('main','side','soup'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS meal_orders (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    guest_id VARCHAR(36) NOT NULL,
    menu_id VARCHAR(64) NOT NULL,
    business_date DATE NOT NULL,
    meal_type VARCHAR(16) NOT NULL,
    menu_version INT UNSIGNED NOT NULL,
    request_fingerprint CHAR(64) NOT NULL,
    dishes_snapshot_json JSON NOT NULL,
    status VARCHAR(16) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    expected_delivery_at DATETIME(3) NOT NULL,
    expected_time_is_demo TINYINT(1) NOT NULL DEFAULT 1,
    preparing_at DATETIME(3) NULL,
    delivered_at DATETIME(3) NULL,
    UNIQUE KEY uq_meal_order_guest_date_meal(guest_id,business_date,meal_type),
    INDEX idx_meal_orders_date_meal_status(business_date,meal_type,status),
    INDEX idx_meal_orders_guest_date(guest_id,business_date,meal_type),
    CONSTRAINT fk_meal_orders_guest FOREIGN KEY(guest_id) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_meal_orders_menu FOREIGN KEY(menu_id) REFERENCES meal_menus(id) ON DELETE RESTRICT,
    CONSTRAINT chk_meal_orders_type CHECK (meal_type IN ('breakfast','lunch','dinner')),
    CONSTRAINT chk_meal_orders_status CHECK (status IN ('reserved','preparing','delivered')),
    CONSTRAINT chk_meal_orders_expected_demo CHECK (expected_time_is_demo IN (0,1))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS meal_order_requests (
    guest_id VARCHAR(36) NOT NULL,
    idempotency_key VARCHAR(120) NOT NULL,
    request_fingerprint CHAR(64) NOT NULL,
    order_id VARCHAR(64) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    PRIMARY KEY(guest_id,idempotency_key),
    CONSTRAINT fk_meal_request_guest FOREIGN KEY(guest_id) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_meal_request_order FOREIGN KEY(order_id) REFERENCES meal_orders(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`
];
