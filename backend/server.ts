import express, { Request, Response } from "express";
import http from "http";
import { Server, Socket } from "socket.io";
import path from "path";
import cors from "cors";
import db from "./database";
import {
  startBotForUser,
  getSocket,
  getAllSockets,
  refreshSniperReadiness,
  activeSockets,
  sniperReady,
} from "./bot";
import fs from "fs";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Attach to global for bot.ts to use
(global as any).io = io;

app.use(cors({ origin: "*" }));
app.use(express.json());

// Load all configured users on startup to keep sessions hot
db.all("SELECT * FROM users", [], (err, rows: any[]) => {
  if (err) {
    console.error("Failed to load users", err);
    return;
  }
  rows.forEach((user) => {
    const userSessionDir = path.join(__dirname, "..", "sessions", user.id);
    const credsPath = path.join(userSessionDir, "creds.json");
    if (!fs.existsSync(credsPath)) {
      return;
    }
    startBotForUser(user.id).catch(console.error);
  });
});

// API Routes
app.post("/api/users", (req: Request, res: Response) => {
  const { id, name, target_group_id, delay_tier = 0 } = req.body;
  db.run(
    `INSERT INTO users (id, name, target_group_id, delay_tier)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
         name=excluded.name,
         target_group_id=excluded.target_group_id,
         delay_tier=excluded.delay_tier`,
    [id, name, target_group_id, delay_tier],
    function (err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      refreshSniperReadiness(id);

      res.json({
        success: true,
        user: { id, name, target_group_id, delay_tier },
      });
    },
  );
});

app.get("/api/users", (req: Request, res: Response) => {
  db.all("SELECT * FROM users", [], (err, rows: any[]) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ users: rows });
  });
});

app.get("/api/session/status/:userId", (req: Request, res: Response) => {
  const userId = req.params.userId as string;
  const sock = getSocket(userId);
  if (sock && sock.authState.creds.me) {
    res.json({ connected: true });
  } else {
    res.json({ connected: false });
  }
});

app.delete("/api/session/:userId", async (req: Request, res: Response) => {
  const userId = req.params.userId as string;
  console.log(`[${userId}] Deleting session and user configuration...`);

  // 1. Remove from database
  db.run("DELETE FROM users WHERE id = ?", [userId], (err) => {
    if (err) console.error("DB wait Error:", err);
  });

  // 2. Logout socket if active
  const sock = getSocket(userId);
  if (sock) {
    try {
      await sock.logout("User requested disconnect");
    } catch {
      // ignore
    }
    activeSockets.delete(userId);
  }
  sniperReady.delete(userId);

  // 3. Delete session files and credentials
  const userSessionDir = path.join(__dirname, "..", "sessions", userId);
  if (fs.existsSync(userSessionDir)) {
    fs.rmSync(userSessionDir, { recursive: true, force: true });
  }

  res.json({ success: true });
});

app.get("/api/groups/:userId", async (req: Request, res: Response) => {
  const userId = req.params.userId as string;
  const sock = getSocket(userId);
  if (!sock) {
    return res
      .status(400)
      .json({ error: "Socket not connected for this user" });
  }

  try {
    const groups = await sock.groupFetchAllParticipating();
    const formattedGroups = Object.values(groups).map((g: any) => ({
      id: g.id,
      name: g.subject,
    }));
    res.json({ groups: formattedGroups });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/test-fire", async (req: Request, res: Response) => {
  const { userId, groupId } = req.body;
  if (!userId || !groupId) {
    return res.status(400).json({ error: "userId and groupId required" });
  }

  const sock = getSocket(userId);
  if (!sock) {
    return res.status(400).json({ error: "Socket not connected" });
  }

  try {
    await sock.sendMessage(groupId, { text: "." });
    res.json({ success: true, message: "Test fired '.' successfully" });
  } catch (e: any) {
    res.status(500).json({ error: e.message || "Failed to fire test message" });
  }
});

// Real-time Socket.io for QR
io.on("connection", (socket: Socket) => {
  console.log("Client connected:", socket.id);

  socket.on(
    "start-session",
    async ({
      userId,
      usePairingCode,
    }: {
      userId: string;
      usePairingCode?: boolean;
    }) => {
      console.log(
        `Starting session for userId: ${userId} (pairing: ${usePairingCode || false})`,
      );
      try {
        await startBotForUser(userId, { usePairingCode });
      } catch (e: any) {
        socket.emit("error", e.message);
      }
    },
  );

  socket.on("disconnect", () => {
    console.log("Client disconnected", socket.id);
  });
});

const PORT = process.env.PORT || 8000;
server.listen(PORT, () => {
  console.log(`WhatsApp Sniper Server running on port ${PORT}`);
});

// --- Graceful Shutdown ---
function gracefulShutdown(signal: string) {
  console.log(`\n🛑 ${signal} received. Shutting down gracefully...`);

  const sockets = getAllSockets();
  for (const [userId, sock] of sockets) {
    try {
      console.log(`   Closing WA socket for ${userId}`);
      sock.end(undefined);
    } catch {
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

  db.close((err) => {
    if (err) {
      console.error("   Error closing database:", err.message);
    } else {
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
