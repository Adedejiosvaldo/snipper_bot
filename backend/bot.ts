import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  WASocket,
  ConnectionState,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import pino from "pino";
import path from "path";
import fs from "fs";
import db from "./database";
import qrcodeLib from "qrcode";
import { Boom } from "@hapi/boom";
import NodeCache from "node-cache";

const sessionsDir = path.join(__dirname, "..", "sessions");
if (!fs.existsSync(sessionsDir)) {
  fs.mkdirSync(sessionsDir, { recursive: true });
}

export const activeSockets = new Map<string, WASocket>();
const reconnectAttempts = new Map<string, number>();
export const sniperReady = new Map<string, boolean>();
const activeConfigs = new Map<
  string,
  { target_group_id: string; delay_tier: number; name: string }
>();
const MAX_RECONNECT_ATTEMPTS = 5;

// Group metadata cache — stores participant lists + addressing_mode to prevent
// WhatsApp from rate-limiting us and to enable proper LID addressing
const groupCache = new NodeCache({ stdTTL: 5 * 60, useClones: false });

export function emitLog(
  userId: string,
  level: "info" | "warn" | "error",
  message: string,
) {
  const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
  const formattedMsg = `[${ts}] ${message}`;

  if (level === "error") console.error(`[${userId}] ${message}`);
  else if (level === "warn") console.warn(`[${userId}] ${message}`);
  else console.log(`[${userId}] ${message}`);

  if ((global as any).io) {
    (global as any).io.emit(`sniper-log-${userId}`, {
      level,
      message: formattedMsg,
    });
  }
}

async function sendWithRetry(
  sock: WASocket,
  groupId: string,
  name: string,
  userId: string,
  maxRetries: number,
) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await sock.sendMessage(groupId, { text: name });
      emitLog(
        userId,
        "info",
        `🚀 Sent Payload: "${name}" (attempt ${attempt}/${maxRetries})`,
      );
      return;
    } catch (e: any) {
      const msg = e?.message || "";
      const isSessionError =
        msg.includes("No sessions") ||
        msg.includes("No SenderKeyRecord") ||
        msg.includes("session");
      const isFatalReject =
        msg.includes("not-acceptable") || msg.includes("forbidden");

      if (isFatalReject) {
        emitLog(
          userId,
          "error",
          `🚫 WhatsApp rejected: "${msg}". Not retrying.`,
        );
        return;
      }

      if (isSessionError && attempt < maxRetries) {
        emitLog(
          userId,
          "warn",
          `⏳ Signal session not ready (LID sync). Retrying in 5s... (${attempt}/${maxRetries})`,
        );
        // Re-fetch group metadata to refresh addressing_mode and participant cache
        try {
          const meta = await sock.groupMetadata(groupId);
          groupCache.set(groupId, meta);
        } catch {
          // ignore
        }
        await new Promise((r) => setTimeout(r, 5000));
      } else {
        emitLog(
          userId,
          "error",
          `❌ Failed to send (attempt ${attempt}/${maxRetries}): ${msg}`,
        );
        if (attempt < maxRetries) await new Promise((r) => setTimeout(r, 3000));
        else return;
      }
    }
  }
}

async function warmupGroupSession(
  sock: WASocket,
  userId: string,
  groupId: string,
  maxAttempts = 12,
): Promise<boolean> {
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      const meta = await sock.groupMetadata(groupId);
      groupCache.set(groupId, meta);
      emitLog(
        userId,
        "info",
        `🔑 Group "${meta.subject}" cached (${meta.participants.length} members)`,
      );
      return true;
    } catch (e: any) {
      emitLog(
        userId,
        "warn",
        `⏳ Warming up sessions... (${i}/${maxAttempts})`,
      );
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  emitLog(
    userId,
    "error",
    `❌ Failed to warm up after ${maxAttempts} attempts`,
  );
  return false;
}

interface BotOptions {
  usePairingCode?: boolean;
}

export async function startBotForUser(
  rawUserId: string,
  options: BotOptions = {},
): Promise<WASocket> {
  // Sanitize: strip +, spaces, dashes, parens — Baileys requires pure digits
  const userId = rawUserId.replace(/[^0-9]/g, "");

  if (activeSockets.has(userId)) {
    return activeSockets.get(userId)!;
  }

  const { usePairingCode = false } = options;

  return new Promise(async (resolve, reject) => {
    try {
      const userSessionDir = path.join(sessionsDir, userId);
      const { state, saveCreds } = await useMultiFileAuthState(userSessionDir);
      const { version, isLatest } = await fetchLatestBaileysVersion();
      console.log(
        `[${userId}] Using WA Web v${version.join(".")}, isLatest: ${isLatest}`,
      );

      const sock = makeWASocket({
        version,
        auth: state,
        // Suppress Baileys internal decryption errors (e.g. Bad MAC/SessionError)
        logger: pino({ level: "silent" }) as any,
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
          if ((global as any).io) {
            (global as any).io.emit(`pairing-code-${userId}`, code);
          }
        } catch (e: any) {
          console.error(
            `[${userId}] Failed to request pairing code:`,
            e?.message,
          );
        }
      }

      // --- Cache group metadata on updates (prevents rate limits) ---
      sock.ev.on("groups.update", async (updates) => {
        for (const update of updates) {
          try {
            const metadata = await sock.groupMetadata(update.id!);
            groupCache.set(update.id!, metadata);
          } catch {
            // ignore
          }
        }

        // --- SNIPER LOGIC (Optimized Hot Path) ---
        const userConfig = activeConfigs.get(userId);
        if (!userConfig) return;

        for (const update of updates) {
          if (
            update.id === userConfig.target_group_id &&
            update.announce === false
          ) {
            const isReady = sniperReady.get(userId) || false;
            emitLog(
              userId,
              "info",
              `⚡ GROUP UNLOCKED! Armed: ${isReady}. FIRING in ${userConfig.delay_tier}ms`,
            );

            setTimeout(async () => {
              await sendWithRetry(
                sock,
                userConfig.target_group_id,
                userConfig.name,
                userId,
                10, // More retries for LID groups
              );
            }, userConfig.delay_tier);
          }
        }
      });

      sock.ev.on("group-participants.update", async (event) => {
        try {
          const metadata = await sock.groupMetadata(event.id);
          groupCache.set(event.id, metadata);
        } catch {
          // ignore
        }
      });

      // --- Connection handling ---
      sock.ev.on(
        "connection.update",
        async (update: Partial<ConnectionState>) => {
          const { connection, lastDisconnect, qr } = update;

          // --- QR Code Generation (skip if using pairing code) ---
          if (qr && !usePairingCode) {
            reconnectAttempts.set(userId, 0);
            sniperReady.set(userId, false);

            if ((global as any).io) {
              try {
                const qrDataUrl = await qrcodeLib.toDataURL(qr);
                (global as any).io.emit(`qr-${userId}`, qrDataUrl);
                console.log(`[${userId}] QR code emitted to frontend`);
              } catch (e) {
                console.error("Error generating QR code", e);
              }
            }
          }

          // --- Connection Closed ---
          if (connection === "close") {
            const statusCode = (lastDisconnect?.error as Boom)?.output
              ?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            const attempts = reconnectAttempts.get(userId) || 0;

            console.log(
              `[${userId}] Connection closed (status: ${statusCode}). Attempt ${attempts + 1}/${MAX_RECONNECT_ATTEMPTS}. Reconnecting: ${shouldReconnect}`,
            );

            activeSockets.delete(userId);
            sniperReady.set(userId, false);

            if (shouldReconnect && attempts < MAX_RECONNECT_ATTEMPTS) {
              if (statusCode === DisconnectReason.restartRequired) {
                console.log(
                  `[${userId}] Restart required. Reconnecting instantly...`,
                );
                startBotForUser(userId).catch(console.error);
              } else {
                reconnectAttempts.set(userId, attempts + 1);
                const delay = Math.pow(2, attempts + 1) * 1000;
                console.log(
                  `[${userId}] Waiting ${delay / 1000}s before reconnecting...`,
                );
                setTimeout(() => {
                  startBotForUser(userId).catch(console.error);
                }, delay);
              }
            } else if (!shouldReconnect) {
              console.log(`[${userId}] User logged out. Cleaning up session.`);
              db.run("UPDATE users SET session_status = ? WHERE id = ?", [
                "disconnected",
                userId,
              ]);
              reconnectAttempts.delete(userId);
              fs.rmSync(userSessionDir, { recursive: true, force: true });

              if ((global as any).io) {
                (global as any).io.emit(
                  `error-${userId}`,
                  "Session logged out. Please scan QR again.",
                );
              }
            } else {
              console.error(
                `[${userId}] Max reconnect attempts reached. Stopping.`,
              );
              reconnectAttempts.delete(userId);
              db.run("UPDATE users SET session_status = ? WHERE id = ?", [
                "error",
                userId,
              ]);
              fs.rmSync(userSessionDir, { recursive: true, force: true });

              if ((global as any).io) {
                (global as any).io.emit(
                  `error-${userId}`,
                  "Connection failed after multiple retries. Please try again.",
                );
              }
            }

            // --- Connection Open ---
          } else if (connection === "open") {
            emitLog(userId, "info", `✅ Connection OPEN and authenticated!`);
            reconnectAttempts.set(userId, 0);
            db.run("UPDATE users SET session_status = ? WHERE id = ?", [
              "connected",
              userId,
            ]);

            if ((global as any).io) {
              (global as any).io.emit(`ready-${userId}`);
            }

            // --- PROACTIVE WARMUP ---
            db.get(
              "SELECT * FROM users WHERE id = ?",
              [userId],
              async (err, user: any) => {
                if (err || !user || !user.target_group_id) {
                  emitLog(userId, "info", `ℹ️ No target group configured yet.`);
                  sniperReady.set(userId, false);
                  return;
                }

                // Cache config in memory for hot path routing
                activeConfigs.set(userId, {
                  target_group_id: user.target_group_id,
                  delay_tier: user.delay_tier,
                  name: user.name,
                });

                emitLog(userId, "info", `🔄 Warming up for target group...`);
                const warmedUp = await warmupGroupSession(
                  sock,
                  userId,
                  user.target_group_id,
                );

                sniperReady.set(userId, warmedUp);
                if (warmedUp) {
                  emitLog(userId, "info", `🎯 SNIPER ARMED AND READY!`);
                  if ((global as any).io) {
                    (global as any).io.emit(`armed-${userId}`);
                  }
                } else {
                  emitLog(
                    userId,
                    "warn",
                    `⚠️ Could not warm up. Will still attempt sends.`,
                  );
                  sniperReady.set(userId, true);
                }
              },
            );
          }
        },
      );

      activeSockets.set(userId, sock);
      resolve(sock);
    } catch (error) {
      reject(error);
    }
  });
}

export function refreshSniperReadiness(userId: string): void {
  const sock = activeSockets.get(userId);
  if (!sock) {
    sniperReady.set(userId, false);
    return;
  }

  db.get(
    "SELECT * FROM users WHERE id = ?",
    [userId],
    async (err, user: any) => {
      if (err || !user || !user.target_group_id) {
        sniperReady.set(userId, false);
        return;
      }

      // Update memory cache
      activeConfigs.set(userId, {
        target_group_id: user.target_group_id,
        delay_tier: user.delay_tier,
        name: user.name,
      });

      sniperReady.set(userId, false);
      emitLog(userId, "info", `🔄 Re-warming for ${user.target_group_id}...`);
      const warmedUp = await warmupGroupSession(
        sock,
        userId,
        user.target_group_id,
      );
      sniperReady.set(userId, warmedUp);

      if (warmedUp) {
        emitLog(userId, "info", `🎯 SNIPER RE-ARMED`);
        if ((global as any).io) {
          (global as any).io.emit(`armed-${userId}`);
        }
      }
    },
  );
}

export function getSocket(userId: string): WASocket | undefined {
  return activeSockets.get(userId);
}

export function getAllSockets(): Map<string, WASocket> {
  return activeSockets;
}
