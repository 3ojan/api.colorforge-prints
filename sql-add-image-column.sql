-- Optional: add image_path to existing table (skip if column already exists)
-- ALTER TABLE hueforge_orders
--   ADD COLUMN image_path VARCHAR(512) NULL AFTER glow_color;

-- Full table (for new database – copy/paste into phpMyAdmin SQL tab)
CREATE TABLE
IF NOT EXISTS hueforge_orders
(
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  stripe_payment_intent_id VARCHAR
(255) NOT NULL,
  tier_colors INT NOT NULL,
  has_glow TINYINT
(1) NOT NULL DEFAULT 0,
  palette_mode VARCHAR
(50) NOT NULL DEFAULT '',
  palette_name VARCHAR
(255) NULL,
  base_colors_json TEXT NOT NULL,
  glow_color VARCHAR
(32) NULL,
  image_path VARCHAR
(512) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
