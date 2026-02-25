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
});

export default db;
