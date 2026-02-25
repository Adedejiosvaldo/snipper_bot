"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const socket_io_1 = require("socket.io");
const path_1 = __importDefault(require("path"));
const cors_1 = __importDefault(require("cors"));
const database_1 = __importDefault(require("./database"));
const bot_1 = require("./bot");
const fs_1 = __importDefault(require("fs"));
const app = (0, express_1.default)();
const server = http_1.default.createServer(app);
const io = new socket_io_1.Server(server, { cors: { origin: "*" } });
// Attach to global for bot.ts to use
global.io = io;
app.use((0, cors_1.default)({ origin: "*" }));
app.use(express_1.default.json());
// Load all configured users on startup to keep sessions hot
database_1.default.all("SELECT * FROM users", [], (err, rows) => {
    if (err) {
        console.error("Failed to load users", err);
        return;
    }
    rows.forEach((user) => {
        const userSessionDir = path_1.default.join(__dirname, "..", "sessions", user.id);
        const credsPath = path_1.default.join(userSessionDir, "creds.json");
        if (!fs_1.default.existsSync(credsPath)) {
            return;
        }
        (0, bot_1.startBotForUser)(user.id).catch(console.error);
    });
});
// API Routes
app.post("/api/users", (req, res) => {
    const { id, name, target_group_id, delay_tier = 0 } = req.body;
    database_1.default.run(`INSERT INTO users (id, name, target_group_id, delay_tier)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
         name=excluded.name,
         target_group_id=excluded.target_group_id,
         delay_tier=excluded.delay_tier`, [id, name, target_group_id, delay_tier], function (err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        (0, bot_1.refreshSniperReadiness)(id);
        res.json({
            success: true,
            user: { id, name, target_group_id, delay_tier },
        });
    });
});
app.get("/api/users", (req, res) => {
    database_1.default.all("SELECT * FROM users", [], (err, rows) => {
        if (err)
            return res.status(500).json({ error: err.message });
        res.json({ users: rows });
    });
});
app.get("/api/session/status/:userId", (req, res) => {
    const userId = req.params.userId;
    const sock = (0, bot_1.getSocket)(userId);
    if (sock && sock.authState.creds.me) {
        res.json({ connected: true });
    }
    else {
        res.json({ connected: false });
    }
});
app.delete("/api/session/:userId", async (req, res) => {
    const userId = req.params.userId;
    console.log(`[${userId}] Deleting session and user configuration...`);
    // 1. Remove from database
    database_1.default.run("DELETE FROM users WHERE id = ?", [userId], (err) => {
        if (err)
            console.error("DB wait Error:", err);
    });
    // 2. Logout socket if active
    const sock = (0, bot_1.getSocket)(userId);
    if (sock) {
        try {
            await sock.logout("User requested disconnect");
        }
        catch {
            // ignore
        }
        bot_1.activeSockets.delete(userId);
    }
    bot_1.sniperReady.delete(userId);
    // 3. Delete session files and credentials
    const userSessionDir = path_1.default.join(__dirname, "..", "sessions", userId);
    if (fs_1.default.existsSync(userSessionDir)) {
        fs_1.default.rmSync(userSessionDir, { recursive: true, force: true });
    }
    res.json({ success: true });
});
app.get("/api/groups/:userId", async (req, res) => {
    const userId = req.params.userId;
    const sock = (0, bot_1.getSocket)(userId);
    if (!sock) {
        return res
            .status(400)
            .json({ error: "Socket not connected for this user" });
    }
    try {
        const groups = await sock.groupFetchAllParticipating();
        const formattedGroups = Object.values(groups).map((g) => ({
            id: g.id,
            name: g.subject,
        }));
        res.json({ groups: formattedGroups });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.post("/api/test-fire", async (req, res) => {
    const { userId, groupId } = req.body;
    if (!userId || !groupId) {
        return res.status(400).json({ error: "userId and groupId required" });
    }
    const sock = (0, bot_1.getSocket)(userId);
    if (!sock) {
        return res.status(400).json({ error: "Socket not connected" });
    }
    try {
        await sock.sendMessage(groupId, { text: "." });
        res.json({ success: true, message: "Test fired '.' successfully" });
    }
    catch (e) {
        res.status(500).json({ error: e.message || "Failed to fire test message" });
    }
});
// Real-time Socket.io for QR
io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);
    socket.on("start-session", async ({ userId, usePairingCode, }) => {
        console.log(`Starting session for userId: ${userId} (pairing: ${usePairingCode || false})`);
        try {
            await (0, bot_1.startBotForUser)(userId, { usePairingCode });
        }
        catch (e) {
            socket.emit("error", e.message);
        }
    });
    socket.on("disconnect", () => {
        console.log("Client disconnected", socket.id);
    });
});
const PORT = process.env.PORT || 8000;
server.listen(PORT, () => {
    console.log(`WhatsApp Sniper Server running on port ${PORT}`);
});
// --- Graceful Shutdown ---
function gracefulShutdown(signal) {
    console.log(`\n🛑 ${signal} received. Shutting down gracefully...`);
    const sockets = (0, bot_1.getAllSockets)();
    for (const [userId, sock] of sockets) {
        try {
            console.log(`   Closing WA socket for ${userId}`);
            sock.end(undefined);
        }
        catch {
            // Ignore close errors
        }
    }
    sockets.clear();
    io.close(() => {
        console.log("   Socket.IO closed");
    });
    server.close(() => {
        console.log("   HTTP server closed");
    });
    database_1.default.close((err) => {
        if (err) {
            console.error("   Error closing database:", err.message);
        }
        else {
            console.log("   Database closed");
        }
        console.log("✅ Cleanup complete. Goodbye!");
        process.exit(0);
    });
    setTimeout(() => {
        console.error("⚠️ Forced exit after timeout");
        process.exit(1);
    }, 5000);
}
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
