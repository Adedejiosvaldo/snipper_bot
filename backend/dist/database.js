"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const sqlite3_1 = __importDefault(require("sqlite3"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const sqlite = sqlite3_1.default.verbose();
const dataDir = path_1.default.join(__dirname, "data");
if (!fs_1.default.existsSync(dataDir)) {
    fs_1.default.mkdirSync(dataDir, { recursive: true });
}
const dbPath = path_1.default.join(dataDir, "users.db");
const db = new sqlite.Database(dbPath, (err) => {
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
exports.default = db;
