"use client";

import { useEffect, useState, useRef } from "react";
import { io, Socket } from "socket.io-client";
import {
  Crosshair,
  Loader2,
  Save,
  QrCode,
  Smartphone,
  Link2,
  LogOut,
  Terminal,
  Activity,
  Trash2,
  Zap,
  CheckCircle2,
  XCircle,
  Clock,
} from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";

const SOCKET_SERVER_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

interface Group {
  id: string;
  name: string;
}

interface LogEntry {
  level: "info" | "warn" | "error";
  message: string;
}

export default function Dashboard() {
  const router = useRouter();
  const [socket, setSocket] = useState<Socket | null>(null);

  // Connection State
  const [userId, setUserId] = useState("");
  const [activeUserId, setActiveUserId] = useState("");
  const [qrCode, setQrCode] = useState("");
  const [status, setStatus] = useState<
    "idle" | "loading" | "qr" | "pairing" | "connected"
  >("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [usePairingCode, setUsePairingCode] = useState(false);
  const [pairingCode, setPairingCode] = useState("");
  const [savedUsers, setSavedUsers] = useState<any[]>([]);

  // Configuration State
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedGroup, setSelectedGroup] = useState("");
  const [nameToDrop, setNameToDrop] = useState("");
  const [delayTier, setDelayTier] = useState<number | string>(0);
  const [savingStatus, setSavingStatus] = useState<
    "idle" | "saving" | "success"
  >("idle");
  const [isArmed, setIsArmed] = useState(false);

  // Console State
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logsEndRef = useRef<HTMLDivElement>(null);

  const fetchSavedUsers = async () => {
    try {
      const res = await fetch(`${SOCKET_SERVER_URL}/api/users`);
      const data = await res.json();
      if (data.users) setSavedUsers(data.users);
    } catch (err) {
      console.error("Failed to fetch saved users", err);
    }
  };

  useEffect(() => {
    fetchSavedUsers();
  }, [status]); // Refresh users when status changes (like connecting/disconnecting)

  useEffect(() => {
    const newSocket = io(SOCKET_SERVER_URL, { autoConnect: true });
    setSocket(newSocket);

    newSocket.on("connect", () => console.log("Connected to API socket"));
    newSocket.on("error", (msg) => {
      setErrorMsg(msg);
      setStatus("idle");
    });

    return () => {
      newSocket.off("connect");
      newSocket.off("error");
      newSocket.close();
    };
  }, []);

  // Auto-populate configuration if the active user is already saved
  useEffect(() => {
    if (!activeUserId) return;
    const userConfig = savedUsers.find((u) => u.id === activeUserId);
    if (userConfig && userConfig.target_group_id) {
      setNameToDrop(userConfig.name || "");
      setSelectedGroup(userConfig.target_group_id || "");
      setDelayTier(
        userConfig.delay_tier !== undefined ? userConfig.delay_tier : 0,
      );

      // If the node is connected, lock the UI state as Armed
      if (userConfig.session_status === "connected") {
        setIsArmed(true);
      }
    } else {
      setNameToDrop("");
      setSelectedGroup("");
      setDelayTier(0);
      setIsArmed(false);
    }
  }, [activeUserId, savedUsers]);

  useEffect(() => {
    if (!socket || !activeUserId) return;

    const onQr = (qrDataUrl: string) => {
      setQrCode(qrDataUrl);
      setStatus("qr");
    };
    const onReady = () => {
      setQrCode("");
      setPairingCode("");
      setStatus("connected");
      fetchGroups(activeUserId);
      setLogs((prev) => [
        ...prev,
        { level: "info", message: `[SYS] Session ${activeUserId} Ready` },
      ]);
    };
    const onPairingCode = (code: string) => {
      setPairingCode(code);
      setStatus("pairing");
    };
    const onLog = (log: LogEntry) => setLogs((prev) => [...prev, log]);

    socket.on(`qr-${activeUserId}`, onQr);
    socket.on(`ready-${activeUserId}`, onReady);
    socket.on(`pairing-code-${activeUserId}`, onPairingCode);
    socket.on(`sniper-log-${activeUserId}`, onLog);

    return () => {
      socket.off(`qr-${activeUserId}`, onQr);
      socket.off(`ready-${activeUserId}`, onReady);
      socket.off(`pairing-code-${activeUserId}`, onPairingCode);
      socket.off(`sniper-log-${activeUserId}`, onLog);
    };
  }, [socket, activeUserId]);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const handleLogout = async () => {
    try {
      await fetch("/api/logout", { method: "POST" });
      router.push("/login");
    } catch (e) {
      console.error("Logout failed");
    }
  };

  const startSession = async (overrideId?: string) => {
    const targetId = overrideId || userId;
    if (!targetId.trim()) {
      setErrorMsg("Please enter a valid Phone Number / User ID");
      return;
    }

    setErrorMsg("");
    setStatus("loading");
    setUserId(targetId);
    setActiveUserId(targetId);
    setLogs([]); // Clear logs for new active session

    try {
      const res = await fetch(
        `${SOCKET_SERVER_URL}/api/session/status/${targetId}`,
      );
      const data = await res.json();

      if (data.connected) {
        setQrCode("");
        setPairingCode("");
        setStatus("connected");
        fetchGroups(targetId);
        setLogs([
          {
            level: "info",
            message: `[SYS] Attached to active session: ${targetId}`,
          },
        ]);
      } else {
        socket?.emit("start-session", { userId: targetId, usePairingCode });
      }
    } catch (err) {
      socket?.emit("start-session", { userId: targetId, usePairingCode });
    }
  };

  const deleteConnection = async (idToDelete: string) => {
    if (!confirm("Are you sure you want to completely delete this session?"))
      return;
    setStatus("loading");
    try {
      await fetch(`${SOCKET_SERVER_URL}/api/session/${idToDelete}`, {
        method: "DELETE",
      });
      if (idToDelete === activeUserId) {
        setStatus("idle");
        setUserId("");
        setActiveUserId("");
        setSelectedGroup("");
        setNameToDrop("");
        setLogs([]);
      }
      fetchSavedUsers();
    } catch (err) {
      setErrorMsg("Failed to delete connection");
      setStatus("connected");
    }
  };

  const fetchGroups = async (uid: string) => {
    try {
      const res = await fetch(`${SOCKET_SERVER_URL}/api/groups/${uid}`);
      const data = await res.json();
      if (data.groups) setGroups(data.groups);
    } catch (err) {
      setErrorMsg("Failed to load WhatsApp groups.");
    }
  };

  const saveConfiguration = async () => {
    if (!selectedGroup || !nameToDrop) {
      setErrorMsg("Please select a group and provide a name to drop.");
      return;
    }
    setSavingStatus("saving");
    try {
      const res = await fetch(`${SOCKET_SERVER_URL}/api/users`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: activeUserId,
          name: nameToDrop,
          target_group_id: selectedGroup,
          delay_tier:
            typeof delayTier === "string" ? parseInt(delayTier, 10) : delayTier,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setSavingStatus("success");
        setIsArmed(true);
        fetchSavedUsers();
        setTimeout(() => setSavingStatus("idle"), 3000);
      } else throw new Error(data.error);
    } catch (err: any) {
      setErrorMsg(err.message || "Failed to save configuration.");
      setSavingStatus("idle");
    }
  };

  const testFire = async (uid: string, gid: string) => {
    if (!gid) {
      setErrorMsg("Please select a group first to test fire");
      return;
    }
    try {
      setLogs((prev) => [
        ...prev,
        { level: "info", message: `[SYS] Firing test message to group...` },
      ]);
      await fetch(`${SOCKET_SERVER_URL}/api/test-fire`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: uid, groupId: gid }),
      });
    } catch (e) {
      setLogs((prev) => [
        ...prev,
        { level: "error", message: `[SYS] Test fire failed` },
      ]);
    }
  };

  return (
    <div className="min-h-screen bg-[#09090b] text-zinc-300 font-sans selection:bg-green-500/30">
      {/* Top Navigation */}
      <nav className="border-b border-white/10 bg-[#09090b]/80 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-green-500/10 flex items-center justify-center border border-green-500/20">
              <Crosshair className="w-5 h-5 text-green-500" />
            </div>
            <span className="font-semibold text-white tracking-tight">
              SniperConsole OS
            </span>
          </div>
          <button
            onClick={handleLogout}
            className="text-zinc-400 hover:text-white transition-colors flex items-center gap-2 text-sm font-medium"
          >
            <LogOut className="w-4 h-4" /> Disconnect
          </button>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto px-6 py-8">
        {/* Error Bar */}
        {errorMsg && (
          <div className="mb-6 p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-red-200 flex items-center gap-3 text-sm animate-in slide-in-from-top-2">
            <XCircle className="w-5 h-5 flex-shrink-0" />
            <p>{errorMsg}</p>
          </div>
        )}

        {/* Dashboard Grid */}
        <div className="grid lg:grid-cols-12 gap-6">
          {/* Left Column (Accounts & Auth) */}
          <div className="lg:col-span-4 space-y-6">
            {/* Widget 1: Connection Manager */}
            <div className="bg-[#18181b] border border-white/5 rounded-2xl p-6 shadow-xl">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-sm font-semibold text-white uppercase tracking-wider flex items-center gap-2">
                  <Smartphone className="w-4 h-4 text-zinc-400" />{" "}
                  Authentication
                </h2>
                <div
                  className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide flex items-center gap-1.5 ${status === "connected" ? "bg-green-500/10 text-green-400 border border-green-500/20" : "bg-yellow-500/10 text-yellow-500 border border-yellow-500/20"}`}
                >
                  {status === "connected" ? (
                    <>
                      <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />{" "}
                      Active
                    </>
                  ) : (
                    <>
                      <span className="w-1.5 h-1.5 rounded-full bg-yellow-500" />{" "}
                      Standby
                    </>
                  )}
                </div>
              </div>

              {status === "idle" ? (
                <div className="space-y-4">
                  <div>
                    <input
                      type="text"
                      placeholder="Phone Number / ID"
                      value={userId}
                      onChange={(e) => setUserId(e.target.value)}
                      className="w-full bg-[#09090b] border border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-green-500/50 focus:ring-1 focus:ring-green-500/50 transition-all placeholder:text-zinc-600"
                    />
                  </div>

                  <div className="flex bg-[#09090b] rounded-lg p-1 border border-white/5">
                    <button
                      onClick={() => setUsePairingCode(false)}
                      className={`flex-1 text-xs font-medium py-2 rounded-md transition-all ${!usePairingCode ? "bg-zinc-800 text-white shadow" : "text-zinc-500 hover:text-zinc-300"}`}
                    >
                      QR Code
                    </button>
                    <button
                      onClick={() => setUsePairingCode(true)}
                      className={`flex-1 text-xs font-medium py-2 rounded-md transition-all ${usePairingCode ? "bg-zinc-800 text-white shadow" : "text-zinc-500 hover:text-zinc-300"}`}
                    >
                      Pairing Code
                    </button>
                  </div>

                  <button
                    onClick={() => startSession()}
                    className="w-full bg-white text-black hover:bg-zinc-200 font-medium py-2.5 px-4 rounded-xl transition-all flex justify-center items-center gap-2 text-sm"
                  >
                    {usePairingCode ? (
                      <>
                        <Link2 className="w-4 h-4" /> Get Code
                      </>
                    ) : (
                      <>
                        <QrCode className="w-4 h-4" /> Generate QR
                      </>
                    )}
                  </button>
                </div>
              ) : status === "loading" ? (
                <div className="py-12 flex flex-col items-center justify-center text-zinc-400 gap-3">
                  <Loader2 className="w-6 h-6 animate-spin text-green-500" />
                  <span className="text-sm">Negotiating Handshake...</span>
                </div>
              ) : status === "qr" ? (
                <div className="flex flex-col items-center animate-in fade-in">
                  <div className="bg-white p-2 rounded-xl mb-4">
                    <Image
                      src={qrCode}
                      alt="QR"
                      width={200}
                      height={200}
                      className="rounded-lg"
                      unoptimized
                    />
                  </div>
                  <button
                    onClick={() => setStatus("idle")}
                    className="text-xs text-zinc-500 hover:text-white transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              ) : status === "pairing" ? (
                <div className="flex flex-col items-center bg-[#09090b] rounded-xl p-6 border border-white/5 animate-in fade-in">
                  <span className="text-3xl font-mono tracking-[0.3em] font-bold text-green-400 mb-4">
                    {pairingCode}
                  </span>
                  <p className="text-xs text-center text-zinc-500">
                    Enter code on primary device
                  </p>
                  <button
                    onClick={() => setStatus("idle")}
                    className="text-xs text-zinc-600 hover:text-white transition-colors mt-6"
                  >
                    Cancel Handshake
                  </button>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-6">
                  <div className="w-16 h-16 bg-green-500/10 rounded-full flex items-center justify-center mb-4">
                    <CheckCircle2 className="w-8 h-8 text-green-500" />
                  </div>
                  <p className="font-medium text-white mb-1">
                    Secure Tunnel Established
                  </p>
                  <p className="text-xs text-zinc-500 font-mono">
                    {activeUserId}
                  </p>
                </div>
              )}
            </div>

            {/* Widget 2: Active Snipers (Master Control) */}
            <div className="bg-[#18181b] border border-white/5 rounded-2xl p-6 shadow-xl flex flex-col min-h-[300px]">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-semibold text-white uppercase tracking-wider flex items-center gap-2">
                  <Activity className="w-4 h-4 text-zinc-400" /> Fleet Overview
                </h2>
                <span className="bg-[#09090b] border border-white/10 text-xs px-2 py-0.5 rounded text-zinc-400">
                  {savedUsers.length} Nodes
                </span>
              </div>

              <div className="flex-1 overflow-y-auto space-y-2 pr-2 custom-scrollbar -mx-2 px-2">
                {savedUsers.length === 0 ? (
                  <p className="text-xs text-zinc-500 text-center py-8">
                    No active configurations found
                  </p>
                ) : (
                  savedUsers.map((u) => (
                    <div
                      key={u.id}
                      className={`group relative bg-[#09090b] border rounded-xl p-3 transition-all ${activeUserId === u.id ? "border-green-500/30 shadow-[0_0_15px_rgba(34,197,94,0.1)]" : "border-white/5 hover:border-white/20"}`}
                    >
                      <div
                        className="flex justify-between items-start mb-2 cursor-pointer"
                        onClick={() => startSession(u.id)}
                      >
                        <div>
                          <p
                            className={`text-sm font-medium ${activeUserId === u.id ? "text-green-400" : "text-white"}`}
                          >
                            {u.name || "Unnamed"}
                          </p>
                          <p className="text-[10px] text-zinc-500 font-mono mt-0.5">
                            {u.id}
                          </p>
                        </div>
                        <div
                          className={`w-2 h-2 rounded-full ${u.session_status === "connected" ? "bg-green-500" : "bg-red-500"}`}
                          title={u.session_status}
                        />
                      </div>

                      {activeUserId === u.id &&
                        u.session_status === "connected" && (
                          <div className="flex items-center gap-2 mt-3 pt-3 border-t border-white/5">
                            <button
                              onClick={() => testFire(u.id, u.target_group_id)}
                              className="flex-1 bg-white/5 hover:bg-white/10 text-xs text-zinc-300 py-1.5 rounded transition-colors flex items-center justify-center gap-1.5"
                            >
                              <Zap className="w-3 h-3 text-yellow-400" /> Test
                              Ping
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                deleteConnection(u.id);
                              }}
                              className="w-8 h-7 bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded flex items-center justify-center transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        )}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Right Column (Config & Console) */}
          <div className="lg:col-span-8 flex flex-col gap-6">
            {/* Widget 3: Configuration */}
            <div
              className={`bg-[#18181b] border border-white/5 rounded-2xl p-6 shadow-xl transition-opacity duration-300 ${status !== "connected" ? "opacity-50 pointer-events-none" : ""}`}
            >
              <h2 className="text-sm font-semibold text-white uppercase tracking-wider flex items-center gap-2 mb-6">
                <Crosshair className="w-4 h-4 text-zinc-400" /> Target
                Parameters
              </h2>

              <div className="grid md:grid-cols-2 gap-6">
                <div className="space-y-4">
                  <div>
                    <label className="block text-[11px] font-medium uppercase tracking-wider text-zinc-500 mb-2">
                      Payload (Text to Send)
                    </label>
                    <input
                      type="text"
                      placeholder="Joseph Adewunmi"
                      value={nameToDrop}
                      onChange={(e) => setNameToDrop(e.target.value)}
                      disabled={isArmed}
                      className="w-full bg-[#09090b] border border-white/5 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium uppercase tracking-wider text-zinc-500 mb-2">
                      Target Vector (Group)
                    </label>
                    <select
                      value={selectedGroup}
                      onChange={(e) => setSelectedGroup(e.target.value)}
                      disabled={isArmed}
                      className="w-full bg-[#09090b] border border-white/5 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500/50 transition-colors text-zinc-300 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <option value="" disabled>
                        -- Select Drop Zone --
                      </option>
                      {groups.length === 0 && (
                        <option disabled>Loading groups...</option>
                      )}
                      {groups.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="space-y-4 flex flex-col">
                  <div className="flex-1">
                    <div className="flex justify-between items-center mb-2">
                      <label className="block text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                        Latency Injection (ms)
                      </label>
                      <span className="text-xs font-mono text-green-400">
                        {delayTier} ms
                      </span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="2000"
                      step="50"
                      value={delayTier}
                      onChange={(e) => setDelayTier(Number(e.target.value))}
                      disabled={isArmed}
                      className="w-full h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-green-500 disabled:opacity-50 disabled:cursor-not-allowed"
                    />

                    <div className="flex justify-between mt-2 text-[10px] text-zinc-600 font-mono">
                      <span>0ms (T0)</span>
                      <span>1000ms</span>
                      <span>2000ms</span>
                    </div>

                    <div className="mt-4">
                      <p className="text-[11px] text-zinc-500 leading-tight">
                        <strong className="text-zinc-300">
                          Strategy Engine:
                        </strong>{" "}
                        0ms for instant acquisition. Stagger subsequent nodes by
                        200-300ms to bypass flood-control heuristics.
                      </p>
                    </div>
                  </div>

                  {isArmed ? (
                    <button
                      onClick={() => setIsArmed(false)}
                      className="w-full py-2.5 px-4 rounded-xl text-sm font-medium transition-all flex items-center justify-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-white border border-white/10"
                    >
                      Edit Parameters
                    </button>
                  ) : (
                    <button
                      onClick={saveConfiguration}
                      disabled={savingStatus !== "idle"}
                      className={`w-full py-2.5 px-4 rounded-xl text-sm font-medium transition-all flex items-center justify-center gap-2
                          ${savingStatus === "success" ? "bg-green-500/20 text-green-400 border border-green-500/20" : "bg-white text-black hover:bg-zinc-200"}`}
                    >
                      {savingStatus === "idle" && (
                        <>
                          <Save className="w-4 h-4" /> Arm Node Configurations
                        </>
                      )}
                      {savingStatus === "saving" && (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />{" "}
                          Compiling...
                        </>
                      )}
                      {savingStatus === "success" && "Node Armed Successfully"}
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Widget 4: Live Firing Console */}
            <div className="bg-[#18181b] border border-white/5 rounded-2xl overflow-hidden shadow-xl flex-1 flex flex-col min-h-[300px]">
              <div className="bg-[#09090b] px-4 py-3 border-b border-white/5 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-zinc-500" />
                  <span className="text-xs font-mono text-zinc-400">
                    node_{activeUserId || "offline"}.log
                  </span>
                </div>
                <div className="flex items-center gap-1.5 opacity-50">
                  <span className="w-2.5 h-2.5 rounded-full bg-red-500"></span>
                  <span className="w-2.5 h-2.5 rounded-full bg-yellow-500"></span>
                  <span className="w-2.5 h-2.5 rounded-full bg-green-500"></span>
                </div>
              </div>

              <div className="flex-1 bg-[#09090b]/50 p-4 font-mono text-[11px] leading-relaxed overflow-y-auto custom-scrollbar">
                {logs.length === 0 ? (
                  <p className="text-zinc-600 text-center py-10 italic">
                    Awaiting telemetry stream...
                  </p>
                ) : (
                  <div className="space-y-1">
                    {logs.map((log, i) => (
                      <div
                        key={i}
                        className={`
                        ${log.level === "error" ? "text-red-400" : ""}
                        ${log.level === "warn" ? "text-yellow-400" : ""}
                        ${log.level === "info" && log.message.includes("🚀") ? "text-green-400 font-bold" : ""}
                        ${log.level === "info" && !log.message.includes("🚀") ? "text-zinc-300" : ""}
                      `}
                      >
                        {log.message}
                      </div>
                    ))}
                    <div ref={logsEndRef} />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
