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
import db, { insertLog } from "./database";
import qrcodeLib from "qrcode";
import { Boom } from "@hapi/boom";
import NodeCache from "node-cache";
import { Sniper, SniperConfig, inSniperWindow, makeFastKeyStore } from "./sniper";

const sessionsDir = path.join(__dirname, "..", "sessions");
if (!fs.existsSync(sessionsDir)) {
  fs.mkdirSync(sessionsDir, { recursive: true });
}

export const activeSockets = new Map<string, WASocket>();
const reconnectAttempts = new Map<string, number>();
export const sniperReady = new Map<string, boolean>();
const snipers = new Map<string, Sniper>();
const MAX_RECONNECT_ATTEMPTS = 5;

// WA Web version: fetch once per process, not on every reconnect.
let waVersion: Promise<[number, number, number]> | null = null;
function getWaVersion() {
  if (!waVersion) {
    waVersion = fetchLatestBaileysVersion().then(({ version, isLatest }) => {
      console.log(`Using WA Web v${version.join(".")}, isLatest: ${isLatest}`);
      return version as [number, number, number];
    });
    waVersion.catch(() => (waVersion = null));
  }
  return waVersion;
}

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

  insertLog(userId, level, formattedMsg);

  if ((global as any).io) {
    (global as any).io.emit(`sniper-log-${userId}`, {
      level,
      message: formattedMsg,
      created_at: Date.now(),
    });
  }
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
      const version = await getWaVersion();

      const sock = makeWASocket({
        version,
        // Keys served from memory; disk writes happen in the background.
        auth: {
          creds: state.creds,
          keys: makeFastKeyStore(state.keys, (e: any) =>
            console.error(`[${userId}] key store write failed:`, e?.message),
          ),
        },
        // Keep device lists for 6h so the pre-window warmup is still valid at fire time.
        userDevicesCache: new NodeCache({ stdTTL: 6 * 60 * 60, useClones: false }),
        // Don't re-process our own sent messages.
        emitOwnEvents: false,
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

      // --- SNIPER: raw-notification trigger lives inside Sniper; this is the backup ---
      const sniper = new Sniper(
        sock,
        userId,
        (level, message) => emitLog(userId, level, message),
        groupCache,
        (dayKey) =>
          db.run("UPDATE users SET last_fired_day = ? WHERE id = ?", [
            dayKey,
            userId,
          ]),
      );
      snipers.get(userId)?.dispose();
      snipers.set(userId, sniper);

      sock.ev.on("groups.update", (updates) => {
        for (const update of updates) {
          if (update.id) sniper.onGroupsUpdate(update.id, update.announce);
        }
        // Refresh metadata in the background, but never during the window:
        // the extra query would share the connection with our send.
        if (inSniperWindow()) return;
        for (const update of updates) {
          sock
            .groupMetadata(update.id!)
            .then((meta) => {
              groupCache.set(update.id!, meta);
            })
            .catch(() => {});
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

            emitLog(
              userId,
              "warn",
              `🔌 Connection closed (status: ${statusCode}). Attempt ${attempts + 1}/${MAX_RECONNECT_ATTEMPTS}. Reconnecting: ${shouldReconnect}`,
            );

            activeSockets.delete(userId);
            sniperReady.set(userId, false);
            if (snipers.get(userId) === sniper) {
              sniper.dispose();
              snipers.delete(userId);
            }

            if (shouldReconnect && attempts < MAX_RECONNECT_ATTEMPTS) {
              if (statusCode === DisconnectReason.restartRequired) {
                emitLog(userId, "warn", `🔄 Restart required. Reconnecting instantly...`);
                startBotForUser(userId).catch(console.error);
              } else {
                reconnectAttempts.set(userId, attempts + 1);
                const delay = Math.pow(2, attempts + 1) * 1000;
                emitLog(userId, "warn", `🔄 Waiting ${delay / 1000}s before reconnecting... (attempt ${attempts + 1}/${MAX_RECONNECT_ATTEMPTS})`);
                setTimeout(() => {
                  startBotForUser(userId).catch(console.error);
                }, delay);
              }
            } else if (!shouldReconnect) {
              emitLog(userId, "error", `🔴 SESSION LOGGED OUT — please rescan QR to reconnect.`);
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
              emitLog(userId, "error", `🔴 Max reconnect attempts reached. Session halted — please reconnect manually.`);
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
            armSniper(userId, "ARMED AND READY");
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
  if (!activeSockets.has(userId)) {
    sniperReady.set(userId, false);
    return;
  }
  armSniper(userId, "RE-ARMED");
}

/** Loads the user's config into their Sniper and warms the target group. */
function armSniper(userId: string, label: string): void {
  db.get(
    "SELECT * FROM users WHERE id = ?",
    [userId],
    async (err, user: any) => {
      const sniper = snipers.get(userId);
      if (err || !user || !user.target_group_id || !sniper) {
        emitLog(userId, "info", `ℹ️ No target group configured yet.`);
        sniperReady.set(userId, false);
        return;
      }

      const cfg: SniperConfig = {
        target_group_id: user.target_group_id,
        delay_tier: Number(user.delay_tier) || 0,
        name: user.name,
        last_fired_day: user.last_fired_day,
      };
      sniper.setConfig(cfg);
      sniperReady.set(userId, false);
      emitLog(userId, "info", `🔄 Warming up for target group...`);

      let warmedUp = false;
      for (let i = 1; i <= 12 && !warmedUp; i++) {
        try {
          warmedUp = await sniper.prewarm();
        } catch (e: any) {
          emitLog(userId, "warn", `⏳ Warming up... (${i}/12): ${e?.message}`);
          await new Promise((r) => setTimeout(r, 5000));
        }
        if (snipers.get(userId) !== sniper) return; // socket replaced meanwhile
      }

      // Even if warmup failed the sniper still fires; sends just do more work.
      sniperReady.set(userId, true);
      if (warmedUp) {
        emitLog(userId, "info", `🎯 SNIPER ${label}!`);
        if ((global as any).io) {
          (global as any).io.emit(`armed-${userId}`);
        }
      } else {
        emitLog(userId, "warn", `⚠️ Could not warm up. Will still attempt sends.`);
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
