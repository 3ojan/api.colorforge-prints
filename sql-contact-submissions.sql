-- Contact form submissions (optional – run if you want to store messages in DB)
CREATE TABLE IF NOT EXISTS contact_submissions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  question TEXT NOT NULL,
  image_path VARCHAR(512) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
