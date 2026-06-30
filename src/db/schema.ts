import { Database } from "bun:sqlite";

export const db = new Database("bot_data.sqlite", { create: true });

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT,
    first_name TEXT,
    chat_id INTEGER UNIQUE NOT NULL,
    first_seen TEXT NOT NULL,
    last_activity TEXT NOT NULL,
    download_count INTEGER DEFAULT 0,
    error_count INTEGER DEFAULT 0,
    newsletter BOOLEAN DEFAULT 1
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS downloads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    url TEXT NOT NULL,
    platform TEXT NOT NULL,
    media_type TEXT NOT NULL,
    success BOOLEAN NOT NULL,
    timestamp TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users (id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    error_context TEXT NOT NULL,
    error_message TEXT NOT NULL,
    original_message TEXT,
    timestamp TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users (id)
  )
`);

db.exec("CREATE INDEX IF NOT EXISTS idx_users_chat_id ON users (chat_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_downloads_user_id ON downloads (user_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_errors_user_id ON errors (user_id)");

export const closeDatabase = () => {
  db.close();
};
