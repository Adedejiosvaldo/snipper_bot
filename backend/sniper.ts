import {
  WASocket,
  BinaryNode,
  SignalKeyStore,
  generateMessageIDV2,
  getAllBinaryNodeChildren,
  jidEncode,
} from "@whiskeysockets/baileys";
import NodeCache from "node-cache";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

// Africa/Lagos is UTC+1 all year (no DST), so plain offset math is exact.
const LAGOS_OFFSET_MS = 60 * 60 * 1000;

const WINDOW_START_MIN = 15 * 60 + 58; // 15:58
const WINDOW_END_MIN = 16 * 60 + 5; // 16:05 (inclusive, whole minute)
const PREWARM_AT = { h: 15, m: 56 }; // refresh devices/sessions right before window

const MAX_SEND_ATTEMPTS = 3;
const RETRY_DELAY_MS = 250;
const BURST_ACK_WAIT_MS = 1500;

function envInt(name: string, fallback: number): number {
  const v = parseInt(process.env[name] || "", 10);
  return Number.isFinite(v) ? v : fallback;
}

function parseClock(value: string | undefined) {
  // "HH:MM:SS.mmm" (seconds and ms optional)
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(
    (value || "").trim(),
  );
  if (!m) return { h: 16, m: 0, s: 0, ms: 0 };
  return {
    h: +m[1],
    m: +m[2],
    s: m[3] ? +m[3] : 0,
    ms: m[4] ? +m[4].padEnd(3, "0") : 0,
  };
}

// Burst mode: send a few times around a predicted unlock moment instead of
// waiting for the unlock notification. Off by default (risk of duplicates and
// of WhatsApp flagging repeated rejected sends).
export const BURST = {
  enabled: process.env.SNIPER_BURST_ENABLED === "true",
  at: parseClock(process.env.SNIPER_BURST_AT || "16:00:00.000"),
  leadMs: envInt("SNIPER_BURST_LEAD_MS", 150),
  count: Math.max(1, envInt("SNIPER_BURST_COUNT", 5)),
  gapMs: Math.max(10, envInt("SNIPER_BURST_GAP_MS", 40)),
};

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

function lagosNow(ms = Date.now()) {
  const d = new Date(ms + LAGOS_OFFSET_MS);
  return {
    weekday: d.getUTCDay(), // 0 = Sun
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    dayKey: d.toISOString().slice(0, 10),
  };
}

function isWeekday(weekday: number) {
  return weekday !== 0 && weekday !== 6;
}

export function inSniperWindow(ms = Date.now()) {
  const t = lagosNow(ms);
  return (
    isWeekday(t.weekday) &&
    t.minutes >= WINDOW_START_MIN &&
    t.minutes <= WINDOW_END_MIN
  );
}

/** Epoch ms of the next weekday occurrence of h:m:s.ms Lagos time. */
function nextWeekdayAt(h: number, m: number, s = 0, ms = 0) {
  const now = Date.now();
  const lagos = new Date(now + LAGOS_OFFSET_MS);
  for (let add = 0; add < 8; add++) {
    const target =
      Date.UTC(
        lagos.getUTCFullYear(),
        lagos.getUTCMonth(),
        lagos.getUTCDate() + add,
        h,
        m,
        s,
        ms,
      ) - LAGOS_OFFSET_MS;
    if (target > now && isWeekday(new Date(target + LAGOS_OFFSET_MS).getUTCDay())) {
      return target;
    }
  }
  return now + 24 * 60 * 60 * 1000;
}

function clock(ms = Date.now()) {
  return new Date(ms + LAGOS_OFFSET_MS).toISOString().slice(11, 23);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Key store: in-memory cache with write-behind persistence.
// Baileys' file store does one disk read per device key while sending; with a
// big group that is hundreds of reads on the hot path. Here reads come from
// memory and writes go to disk in order, without making the sender wait.
// ---------------------------------------------------------------------------

export function makeFastKeyStore(
  store: SignalKeyStore,
  onError: (e: unknown) => void,
): SignalKeyStore {
  const cache = new Map<string, any>();
  let writes: Promise<void> = Promise.resolve();
  const key = (type: string, id: string) => `${type}.${id}`;

  return {
    async get(type, ids) {
      const data: { [id: string]: any } = {};
      const missing: string[] = [];
      for (const id of ids) {
        const k = key(type, id);
        if (cache.has(k)) {
          const v = cache.get(k);
          if (v != null) data[id] = v;
        } else {
          missing.push(id);
        }
      }
      if (missing.length) {
        const fetched = await store.get(type, missing);
        for (const id of missing) {
          const v = fetched[id];
          cache.set(key(type, id), v ?? null);
          if (v != null) data[id] = v;
        }
      }
      return data;
    },
    set(data) {
      for (const type in data) {
        const entries = (data as any)[type];
        for (const id in entries) cache.set(key(type, id), entries[id] ?? null);
      }
      writes = writes
        .then(() => store.set(data))
        .catch((e) => onError(e));
    },
    async clear() {
      cache.clear();
      await writes;
      await store.clear?.();
    },
  };
}

// ---------------------------------------------------------------------------
// Per-user sniper
// ---------------------------------------------------------------------------

export interface SniperConfig {
  target_group_id: string;
  delay_tier: number;
  name: string;
  last_fired_day?: string | null;
}

type Log = (level: "info" | "warn" | "error", message: string) => void;

interface PendingSend {
  kind: "normal" | "burst";
  attempt: number;
  sentAt: number; // ms when the stanza was written to the socket
  startAt: number; // ms when we started building it
  resolve: (accepted: boolean) => void;
}

export class Sniper {
  private cfg: SniperConfig | null = null;
  private firedDay: string | null = null;
  private pending = new Map<string, PendingSend>();
  private timers: NodeJS.Timeout[] = [];
  private burstTimers: NodeJS.Timeout[] = [];
  private burstChain: Promise<void> = Promise.resolve();
  private burstInFlight: Promise<boolean>[] = [];
  private burstAccepted = false;
  private burstStopped = false;
  private senderKeySnapshot: Record<string, boolean> | null = null;
  private unlockedAt = 0;
  private disposed = false;

  constructor(
    private sock: WASocket,
    private userId: string,
    private log: Log,
    private groupCache: NodeCache,
    private markFired: (dayKey: string) => void,
  ) {
    // Raw notification listener: fires straight from the decoded frame,
    // before Baileys turns it into a fake message and emits groups.update.
    sock.ws.on("CB:notification,type:w:gp2", (node: BinaryNode) =>
      this.onGroupNotification(node),
    );
    sock.ws.on("CB:ack,class:message", (node: BinaryNode) => this.onAck(node));
  }

  setConfig(cfg: SniperConfig) {
    const groupChanged = this.cfg?.target_group_id !== cfg.target_group_id;
    this.cfg = cfg;
    if (cfg.last_fired_day) this.firedDay = cfg.last_fired_day;
    if (groupChanged) this.senderKeySnapshot = null;
    this.schedule();
  }

  dispose() {
    this.disposed = true;
    this.clearTimers();
    for (const p of this.pending.values()) p.resolve(false);
    this.pending.clear();
  }

  // ---- fire triggers -----------------------------------------------------

  private onGroupNotification(node: BinaryNode) {
    const recvAt = Date.now();
    if (!this.cfg || node.attrs.from !== this.cfg.target_group_id) return;
    const unlocked = getAllBinaryNodeChildren(node).some(
      (c) => c.tag === "not_announcement",
    );
    if (!unlocked) return;
    const serverT = node.attrs.t ? +node.attrs.t * 1000 : 0;
    this.onUnlock("raw", recvAt, serverT);
  }

  /** Backup trigger from Baileys' groups.update event. */
  onGroupsUpdate(groupId: string, announce: boolean | undefined) {
    if (!this.cfg || groupId !== this.cfg.target_group_id || announce !== false)
      return;
    this.onUnlock("groups.update", Date.now(), 0);
  }

  private onUnlock(source: string, recvAt: number, serverT: number) {
    const cfg = this.cfg!;
    const today = lagosNow(recvAt).dayKey;

    // Second trigger for the same unlock (raw + groups.update) — ignore quietly.
    if (recvAt - this.unlockedAt < 10_000) return;
    this.unlockedAt = recvAt;

    if (!inSniperWindow(recvAt)) {
      this.log("warn", `⏰ Unlock at ${clock(recvAt)} is outside the sniper window (Mon–Fri 15:58–16:05). Not firing.`);
      return;
    }
    if (this.firedDay === today) {
      this.log("warn", `✅ Unlock seen (${source}) but already fired today (${today}).`);
      return;
    }

    // Stop any burst attempts that have not gone out yet.
    this.burstStopped = true;
    for (const t of this.burstTimers) clearTimeout(t);
    this.burstTimers = [];

    const inFlight = [...this.burstInFlight];
    if (inFlight.length) {
      // Burst sends may still be accepted; wait for their acks so we don't post twice.
      this.waitForBurst(inFlight).then((accepted) => {
        if (accepted || this.firedDay === today) return;
        this.firePayload(today, cfg);
      });
    } else {
      this.firePayload(today, cfg);
    }

    const lag = serverT ? ` | server t=${clock(serverT)} (1s resolution)` : "";
    this.log("info", `⚡ GROUP UNLOCKED via ${source} at ${clock(recvAt)}${lag}. Delay tier ${cfg.delay_tier}ms.`);
  }

  private firePayload(today: string, cfg: SniperConfig) {
    this.firedDay = today;
    this.markFired(today);
    const go = () =>
      this.sendWithRetry(cfg, "normal").catch((e) =>
        this.log("error", `Fire error: ${e?.message}`),
      );
    if (cfg.delay_tier > 0) setTimeout(go, cfg.delay_tier);
    else go();
  }

  private async waitForBurst(inFlight: Promise<boolean>[]) {
    const timeout = sleep(BURST_ACK_WAIT_MS).then(() => false);
    const anyAccepted = Promise.all(inFlight).then((r) => r.some(Boolean));
    return Promise.race([anyAccepted, timeout]);
  }

  // ---- sending -----------------------------------------------------------

  /** Writes one message to the socket. Resolves when the server acks it. */
  private async sendOnce(
    cfg: SniperConfig,
    kind: PendingSend["kind"],
    attempt: number,
  ): Promise<{ written: true; accepted: Promise<boolean> }> {
    const startAt = Date.now();
    const messageId = generateMessageIDV2(this.sock.user?.id);
    let resolve!: (ok: boolean) => void;
    const accepted = new Promise<boolean>((r) => (resolve = r));
    this.pending.set(messageId, { kind, attempt, startAt, sentAt: 0, resolve });
    setTimeout(() => {
      const p = this.pending.get(messageId);
      if (p) {
        this.pending.delete(messageId);
        this.log("warn", `⌛ No server ack for ${kind} attempt ${attempt} after 10s.`);
        p.resolve(false);
      }
    }, 10_000);

    try {
      // Skip generateWAMessage (link-preview lookup, extra proto work) and
      // relay a plain text message directly.
      await this.sock.relayMessage(
        cfg.target_group_id,
        { conversation: cfg.name },
        { messageId },
      );
    } catch (e) {
      this.pending.delete(messageId);
      resolve(false);
      throw e;
    }
    const p = this.pending.get(messageId);
    if (p) p.sentAt = Date.now();
    this.log("info", `📤 ${kind} attempt ${attempt} written at ${clock()} (+${Date.now() - startAt}ms build/encrypt)`);
    return { written: true, accepted };
  }

  private async sendWithRetry(cfg: SniperConfig, kind: "normal") {
    // A failed burst may have left Baileys thinking every device already has
    // our group key. Put the real state back before the real send.
    this.restoreSenderKeyMemory();

    for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
      try {
        const { accepted } = await this.sendOnce(cfg, kind, attempt);
        if (await accepted) return;
        // Server refused (error ack) — nothing was delivered, safe to retry.
        if (attempt < MAX_SEND_ATTEMPTS) {
          this.restoreSenderKeyMemory();
          await sleep(RETRY_DELAY_MS);
        }
      } catch (e: any) {
        const msg = e?.message || "";
        if (msg.includes("not-acceptable") || msg.includes("forbidden")) {
          this.log("error", `🚫 WhatsApp rejected: "${msg}". Not retrying.`);
          return;
        }
        this.log("error", `❌ Send failed (attempt ${attempt}/${MAX_SEND_ATTEMPTS}): ${msg}`);
        if (attempt >= MAX_SEND_ATTEMPTS) return;
        if (/session|SenderKey/i.test(msg)) {
          await this.prewarm().catch(() => {});
        } else {
          await sleep(RETRY_DELAY_MS);
        }
      }
    }
  }

  private onAck(node: BinaryNode) {
    const id = node.attrs.id;
    const p = id ? this.pending.get(id) : undefined;
    if (!p) return;
    this.pending.delete(id);
    const now = Date.now();
    const rtt = p.sentAt ? now - p.sentAt : -1;
    const error = node.attrs.error;

    if (error) {
      this.log("warn", `🚫 ${p.kind} attempt ${p.attempt} refused by server (error ${error}) after ${rtt}ms.`);
      p.resolve(false);
      return;
    }

    this.log("info", `✅ ${p.kind} attempt ${p.attempt} ACCEPTED at ${clock(now)} | ack RTT ${rtt}ms | total ${now - p.startAt}ms`);
    if (p.kind === "burst" && !this.burstAccepted) {
      this.burstAccepted = true;
      this.senderKeySnapshot = null;
      for (const t of this.burstTimers) clearTimeout(t);
      this.burstTimers = [];
      const today = lagosNow(now).dayKey;
      this.firedDay = today;
      this.markFired(today);
      this.log("info", `🎯 Burst hit — posted before the unlock notification arrived.`);
    }
    if (p.kind === "normal") this.senderKeySnapshot = null;
    p.resolve(true);
  }

  // ---- burst mode --------------------------------------------------------

  private async runBurst() {
    const cfg = this.cfg;
    if (!cfg || this.disposed) return;
    const today = lagosNow().dayKey;
    if (this.firedDay === today) return;

    // Remember which devices really have our group key before any burst send.
    const mem = await this.sock.authState.keys.get("sender-key-memory", [
      cfg.target_group_id,
    ]);
    this.senderKeySnapshot = { ...(mem[cfg.target_group_id] || {}) };
    this.burstAccepted = false;
    this.burstStopped = false;
    this.burstInFlight = [];

    this.log("info", `💥 Burst: ${BURST.count} sends, ${BURST.gapMs}ms apart, starting ${clock()}.`);

    const start = Date.now();
    for (let i = 0; i < BURST.count; i++) {
      const t = setTimeout(() => {
        // Attempts run one after another: overlapping sends would share
        // Baileys' key transaction and could skip the group key for some devices.
        this.burstChain = this.burstChain.then(async () => {
          if (this.burstStopped || this.burstAccepted || this.disposed || this.firedDay === today)
            return;
          this.restoreSenderKeyMemory();
          const sent = this.sendOnce(cfg, "burst", i + 1);
          // Track it from the start so an unlock arriving mid-send waits for it.
          this.burstInFlight.push(sent.then((r) => r.accepted, () => false));
          await sent.catch((e: any) =>
            this.log("warn", `Burst attempt ${i + 1} failed locally: ${e?.message}`),
          );
        });
      }, Math.max(0, start + i * BURST.gapMs - Date.now()));
      this.burstTimers.push(t);
    }

    // After the burst settles, undo the memory changes from refused sends.
    setTimeout(async () => {
      await this.burstChain;
      await Promise.all(this.burstInFlight);
      if (!this.burstAccepted) this.restoreSenderKeyMemory();
      this.burstInFlight = [];
      this.schedule();
    }, BURST.count * BURST.gapMs + BURST_ACK_WAIT_MS);
  }

  private restoreSenderKeyMemory() {
    const cfg = this.cfg;
    if (!cfg || !this.senderKeySnapshot) return;
    // Synchronous cache update inside the fast key store; disk write follows.
    Promise.resolve(
      this.sock.authState.keys.set({
        "sender-key-memory": {
          [cfg.target_group_id]: { ...this.senderKeySnapshot },
        },
      }),
    ).catch(() => {});
  }

  // ---- warmup ------------------------------------------------------------

  /**
   * Loads everything the send needs ahead of time: group members, their
   * devices, and an encryption session with every device. Without this the
   * first send can need two extra round trips to WhatsApp.
   */
  async prewarm(): Promise<boolean> {
    const cfg = this.cfg;
    if (!cfg) return false;
    const t0 = Date.now();
    const meta = await this.sock.groupMetadata(cfg.target_group_id);
    this.groupCache.set(cfg.target_group_id, meta);

    const devices = await this.sock.getUSyncDevices(
      meta.participants.map((p) => p.id),
      false,
      false,
    );
    const server = meta.addressingMode === "lid" ? "lid" : "s.whatsapp.net";
    const deviceJids = devices.map((d) => jidEncode(d.user, server, d.device));
    await this.sock.assertSessions(deviceJids, false);
    // Pull the group key memory into the in-memory store too.
    await this.sock.authState.keys.get("sender-key-memory", [cfg.target_group_id]);

    this.log("info", `🔑 Warmed "${meta.subject}": ${meta.participants.length} members, ${deviceJids.length} devices, sessions ready (${Date.now() - t0}ms).`);
    return true;
  }

  // ---- scheduling --------------------------------------------------------

  private clearTimers() {
    for (const t of [...this.timers, ...this.burstTimers]) clearTimeout(t);
    this.timers = [];
    this.burstTimers = [];
  }

  private schedule() {
    if (this.disposed) return;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];

    const warmAt = nextWeekdayAt(PREWARM_AT.h, PREWARM_AT.m);
    this.timers.push(
      setTimeout(() => {
        this.prewarm()
          .catch((e) => this.log("warn", `Pre-window warmup failed: ${e?.message}`))
          .finally(() => this.schedule());
      }, warmAt - Date.now()),
    );

    if (BURST.enabled) {
      const { h, m, s, ms } = BURST.at;
      const burstAt = nextWeekdayAt(h, m, s, ms) - BURST.leadMs;
      if (inSniperWindow(burstAt) || inSniperWindow(burstAt + BURST.leadMs)) {
        this.timers.push(
          setTimeout(() => this.runBurst(), Math.max(0, burstAt - Date.now())),
        );
      } else {
        this.log("warn", `SNIPER_BURST_AT is outside the sniper window — burst disabled.`);
      }
    }
  }
}
