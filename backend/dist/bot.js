"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sniperReady = exports.activeSockets = void 0;
exports.emitLog = emitLog;
exports.startBotForUser = startBotForUser;
exports.refreshSniperReadiness = refreshSniperReadiness;
exports.getSocket = getSocket;
exports.getAllSockets = getAllSockets;
const baileys_1 = __importStar(require("@whiskeysockets/baileys"));
const pino_1 = __importDefault(require("pino"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const database_1 = __importDefault(require("./database"));
const qrcode_1 = __importDefault(require("qrcode"));
const node_cache_1 = __importDefault(require("node-cache"));
const sessionsDir = path_1.default.join(__dirname, "..", "sessions");
if (!fs_1.default.existsSync(sessionsDir)) {
    fs_1.default.mkdirSync(sessionsDir, { recursive: true });
}
exports.activeSockets = new Map();
const reconnectAttempts = new Map();
exports.sniperReady = new Map();
const activeConfigs = new Map();
const MAX_RECONNECT_ATTEMPTS = 5;
// Group metadata cache — stores participant lists + addressing_mode to prevent
// WhatsApp from rate-limiting us and to enable proper LID addressing
const groupCache = new node_cache_1.default({ stdTTL: 5 * 60, useClones: false });
function emitLog(userId, level, message) {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    const formattedMsg = `[${ts}] ${message}`;
    if (level === "error")
        console.error(`[${userId}] ${message}`);
    else if (level === "warn")
        console.warn(`[${userId}] ${message}`);
    else
        console.log(`[${userId}] ${message}`);
    if (global.io) {
        global.io.emit(`sniper-log-${userId}`, {
            level,
            message: formattedMsg,
        });
    }
}
async function sendWithRetry(sock, groupId, name, userId, maxRetries) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            await sock.sendMessage(groupId, { text: name });
            emitLog(userId, "info", `🚀 Sent Payload: "${name}" (attempt ${attempt}/${maxRetries})`);
            return;
        }
        catch (e) {
            const msg = e?.message || "";
            const isSessionError = msg.includes("No sessions") ||
                msg.includes("No SenderKeyRecord") ||
                msg.includes("session");
            const isFatalReject = msg.includes("not-acceptable") || msg.includes("forbidden");
            if (isFatalReject) {
                emitLog(userId, "error", `🚫 WhatsApp rejected: "${msg}". Not retrying.`);
                return;
            }
            if (isSessionError && attempt < maxRetries) {
                emitLog(userId, "warn", `⏳ Signal session not ready (LID sync). Retrying in 5s... (${attempt}/${maxRetries})`);
                // Re-fetch group metadata to refresh addressing_mode and participant cache
                try {
                    const meta = await sock.groupMetadata(groupId);
                    groupCache.set(groupId, meta);
                }
                catch {
                    // ignore
                }
                await new Promise((r) => setTimeout(r, 5000));
            }
            else {
                emitLog(userId, "error", `❌ Failed to send (attempt ${attempt}/${maxRetries}): ${msg}`);
                if (attempt < maxRetries)
                    await new Promise((r) => setTimeout(r, 3000));
                else
                    return;
            }
        }
    }
}
async function warmupGroupSession(sock, userId, groupId, maxAttempts = 12) {
    for (let i = 1; i <= maxAttempts; i++) {
        try {
            const meta = await sock.groupMetadata(groupId);
            groupCache.set(groupId, meta);
            emitLog(userId, "info", `🔑 Group "${meta.subject}" cached (${meta.participants.length} members)`);
            return true;
        }
        catch (e) {
            emitLog(userId, "warn", `⏳ Warming up sessions... (${i}/${maxAttempts})`);
            await new Promise((r) => setTimeout(r, 5000));
        }
    }
    emitLog(userId, "error", `❌ Failed to warm up after ${maxAttempts} attempts`);
    return false;
}
async function startBotForUser(rawUserId, options = {}) {
    // Sanitize: strip +, spaces, dashes, parens — Baileys requires pure digits
    const userId = rawUserId.replace(/[^0-9]/g, "");
    if (exports.activeSockets.has(userId)) {
        return exports.activeSockets.get(userId);
    }
    const { usePairingCode = false } = options;
    return new Promise(async (resolve, reject) => {
        try {
            const userSessionDir = path_1.default.join(sessionsDir, userId);
            const { state, saveCreds } = await (0, baileys_1.useMultiFileAuthState)(userSessionDir);
            const { version, isLatest } = await (0, baileys_1.fetchLatestBaileysVersion)();
            console.log(`[${userId}] Using WA Web v${version.join(".")}, isLatest: ${isLatest}`);
            const sock = (0, baileys_1.default)({
                version,
                auth: state,
                // Suppress Baileys internal decryption errors (e.g. Bad MAC/SessionError)
                logger: (0, pino_1.default)({ level: "silent" }),
                printQRInTerminal: false,
                browser: ["Mac OS", "Chrome", "110.0.5481.177"],
                // Fix for 515/428 connection drops and Bad MAC decryption errors
                keepAliveIntervalMs: 20000,
                defaultQueryTimeoutMs: 60000,
                retryRequestDelayMs: 5000,
                maxMsgRetryCount: 5,
                markOnlineOnConnect: true,
                shouldSyncHistoryMessage: () => false,
                cachedGroupMetadata: async (jid) => groupCache.get(jid),
            });
            sock.ev.on("creds.update", saveCreds);
            // --- Pairing Code Authentication ---
            if (usePairingCode && !sock.authState.creds.registered) {
                // Wait a moment for the socket to initialize before requesting
                await new Promise((r) => setTimeout(r, 3000));
                try {
                    const code = await sock.requestPairingCode(userId);
                    console.log(`[${userId}] 🔗 Pairing code: ${code}`);
                    if (global.io) {
                        global.io.emit(`pairing-code-${userId}`, code);
                    }
                }
                catch (e) {
                    console.error(`[${userId}] Failed to request pairing code:`, e?.message);
                }
            }
            // --- Cache group metadata on updates (prevents rate limits) ---
            sock.ev.on("groups.update", async (updates) => {
                for (const update of updates) {
                    try {
                        const metadata = await sock.groupMetadata(update.id);
                        groupCache.set(update.id, metadata);
                    }
                    catch {
                        // ignore
                    }
                }
                // --- SNIPER LOGIC (Optimized Hot Path) ---
                const userConfig = activeConfigs.get(userId);
                if (!userConfig)
                    return;
                for (const update of updates) {
                    if (update.id === userConfig.target_group_id &&
                        update.announce === false) {
                        const isReady = exports.sniperReady.get(userId) || false;
                        emitLog(userId, "info", `⚡ GROUP UNLOCKED! Armed: ${isReady}. FIRING in ${userConfig.delay_tier}ms`);
                        setTimeout(async () => {
                            await sendWithRetry(sock, userConfig.target_group_id, userConfig.name, userId, 10);
                        }, userConfig.delay_tier);
                    }
                }
            });
            sock.ev.on("group-participants.update", async (event) => {
                try {
                    const metadata = await sock.groupMetadata(event.id);
                    groupCache.set(event.id, metadata);
                }
                catch {
                    // ignore
                }
            });
            // --- Connection handling ---
            sock.ev.on("connection.update", async (update) => {
                const { connection, lastDisconnect, qr } = update;
                // --- QR Code Generation (skip if using pairing code) ---
                if (qr && !usePairingCode) {
                    reconnectAttempts.set(userId, 0);
                    exports.sniperReady.set(userId, false);
                    if (global.io) {
                        try {
                            const qrDataUrl = await qrcode_1.default.toDataURL(qr);
                            global.io.emit(`qr-${userId}`, qrDataUrl);
                            console.log(`[${userId}] QR code emitted to frontend`);
                        }
                        catch (e) {
                            console.error("Error generating QR code", e);
                        }
                    }
                }
                // --- Connection Closed ---
                if (connection === "close") {
                    const statusCode = lastDisconnect?.error?.output
                        ?.statusCode;
                    const shouldReconnect = statusCode !== baileys_1.DisconnectReason.loggedOut;
                    const attempts = reconnectAttempts.get(userId) || 0;
                    console.log(`[${userId}] Connection closed (status: ${statusCode}). Attempt ${attempts + 1}/${MAX_RECONNECT_ATTEMPTS}. Reconnecting: ${shouldReconnect}`);
                    exports.activeSockets.delete(userId);
                    exports.sniperReady.set(userId, false);
                    if (shouldReconnect && attempts < MAX_RECONNECT_ATTEMPTS) {
                        if (statusCode === baileys_1.DisconnectReason.restartRequired) {
                            console.log(`[${userId}] Restart required. Reconnecting instantly...`);
                            startBotForUser(userId).catch(console.error);
                        }
                        else {
                            reconnectAttempts.set(userId, attempts + 1);
                            const delay = Math.pow(2, attempts + 1) * 1000;
                            console.log(`[${userId}] Waiting ${delay / 1000}s before reconnecting...`);
                            setTimeout(() => {
                                startBotForUser(userId).catch(console.error);
                            }, delay);
                        }
                    }
                    else if (!shouldReconnect) {
                        console.log(`[${userId}] User logged out. Cleaning up session.`);
                        database_1.default.run("UPDATE users SET session_status = ? WHERE id = ?", [
                            "disconnected",
                            userId,
                        ]);
                        reconnectAttempts.delete(userId);
                        fs_1.default.rmSync(userSessionDir, { recursive: true, force: true });
                        if (global.io) {
                            global.io.emit(`error-${userId}`, "Session logged out. Please scan QR again.");
                        }
                    }
                    else {
                        console.error(`[${userId}] Max reconnect attempts reached. Stopping.`);
                        reconnectAttempts.delete(userId);
                        database_1.default.run("UPDATE users SET session_status = ? WHERE id = ?", [
                            "error",
                            userId,
                        ]);
                        fs_1.default.rmSync(userSessionDir, { recursive: true, force: true });
                        if (global.io) {
                            global.io.emit(`error-${userId}`, "Connection failed after multiple retries. Please try again.");
                        }
                    }
                    // --- Connection Open ---
                }
                else if (connection === "open") {
                    emitLog(userId, "info", `✅ Connection OPEN and authenticated!`);
                    reconnectAttempts.set(userId, 0);
                    database_1.default.run("UPDATE users SET session_status = ? WHERE id = ?", [
                        "connected",
                        userId,
                    ]);
                    if (global.io) {
                        global.io.emit(`ready-${userId}`);
                    }
                    // --- PROACTIVE WARMUP ---
                    database_1.default.get("SELECT * FROM users WHERE id = ?", [userId], async (err, user) => {
                        if (err || !user || !user.target_group_id) {
                            emitLog(userId, "info", `ℹ️ No target group configured yet.`);
                            exports.sniperReady.set(userId, false);
                            return;
                        }
                        // Cache config in memory for hot path routing
                        activeConfigs.set(userId, {
                            target_group_id: user.target_group_id,
                            delay_tier: user.delay_tier,
                            name: user.name,
                        });
                        emitLog(userId, "info", `🔄 Warming up for target group...`);
                        const warmedUp = await warmupGroupSession(sock, userId, user.target_group_id);
                        exports.sniperReady.set(userId, warmedUp);
                        if (warmedUp) {
                            emitLog(userId, "info", `🎯 SNIPER ARMED AND READY!`);
                            if (global.io) {
                                global.io.emit(`armed-${userId}`);
                            }
                        }
                        else {
                            emitLog(userId, "warn", `⚠️ Could not warm up. Will still attempt sends.`);
                            exports.sniperReady.set(userId, true);
                        }
                    });
                }
            });
            exports.activeSockets.set(userId, sock);
            resolve(sock);
        }
        catch (error) {
            reject(error);
        }
    });
}
function refreshSniperReadiness(userId) {
    const sock = exports.activeSockets.get(userId);
    if (!sock) {
        exports.sniperReady.set(userId, false);
        return;
    }
    database_1.default.get("SELECT * FROM users WHERE id = ?", [userId], async (err, user) => {
        if (err || !user || !user.target_group_id) {
            exports.sniperReady.set(userId, false);
            return;
        }
        // Update memory cache
        activeConfigs.set(userId, {
            target_group_id: user.target_group_id,
            delay_tier: user.delay_tier,
            name: user.name,
        });
        exports.sniperReady.set(userId, false);
        emitLog(userId, "info", `🔄 Re-warming for ${user.target_group_id}...`);
        const warmedUp = await warmupGroupSession(sock, userId, user.target_group_id);
        exports.sniperReady.set(userId, warmedUp);
        if (warmedUp) {
            emitLog(userId, "info", `🎯 SNIPER RE-ARMED`);
            if (global.io) {
                global.io.emit(`armed-${userId}`);
            }
        }
    });
}
function getSocket(userId) {
    return exports.activeSockets.get(userId);
}
function getAllSockets() {
    return exports.activeSockets;
}
