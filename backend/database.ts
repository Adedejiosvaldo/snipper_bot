import sqlite3 from "sqlite3";
import path from "path";
import fs from "fs";

const sqlite = sqlite3.verbose();

const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, "users.db");
const db = new sqlite.Database(dbPath, (err: Error | null) => {
  if (err) {
    console.error("Error opening database", err.message);
  }
});

db.serialize(() => {
  db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            target_group_id TEXT NOT NULL,
            delay_tier INTEGER DEFAULT 0,
            session_status TEXT DEFAULT 'disconnected'
        )
    `);

  db.run(`
        CREATE TABLE IF NOT EXISTS user_logs (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id    TEXT    NOT NULL,
            level      TEXT    NOT NULL,
            message    TEXT    NOT NULL,
            created_at INTEGER NOT NULL
        )
    `);

  db.run(`
        CREATE INDEX IF NOT EXISTS idx_user_logs_uid ON user_logs(user_id)
    `);
});

export function insertLog(
  userId: string,
  level: string,
  message: string,
): void {
  const ts = Date.now();
  db.run(
    "INSERT INTO user_logs (user_id, level, message, created_at) VALUES (?, ?, ?, ?)",
    [userId, level, message, ts],
    function () {
      // Trim to last 500 rows per user after each insert
      db.run(
        `DELETE FROM user_logs WHERE user_id = ? AND id NOT IN
         (SELECT id FROM user_logs WHERE user_id = ? ORDER BY id DESC LIMIT 500)`,
        [userId, userId],
      );
    },
  );
}

export default db;
