# WhatsApp Sniper

A multi-user WhatsApp automation tool that monitors a target group and fires a configured message the moment the group is unlocked — within a precise daily time window.

## How It Works

Each registered user connects their WhatsApp account via QR code or pairing code. The bot watches a configured target group for the `announce → false` event (group unlocked). When that event fires inside the sniper window (**Mon–Fri, 3:58–4:05 PM WAT**), the bot immediately sends the user's configured name/payload to the group, with a configurable millisecond delay tier for staggered firing. Each user can only fire once per calendar day.

## Architecture

```
Browser → Nginx (:8080) → ┬─ /api/auth, /api/logout  → Next.js frontend (:3000)
                           ├─ /api/*                  → Express backend  (:8000)
                           ├─ /socket.io/*             → Socket.IO (real-time logs)
                           └─ /*                       → Next.js frontend (:3000)
```

| Service | Stack |
|---|---|
| **Frontend** | Next.js 15, React, Tailwind CSS |
| **Backend** | Node.js, Express, Baileys (WhatsApp Web API) |
| **Database** | SQLite (persisted via Docker volume) |
| **Real-time** | Socket.IO (QR codes, live console logs, armed status) |
| **Proxy** | Nginx (reverse proxy, single-port entry) |

## Prerequisites

- Docker & Docker Compose
- A VPS or server with a public domain/subdomain
- Port 8080 open on the server firewall

## Deployment

Run the interactive deploy script:

```bash
bash deploy.sh
```

It will prompt for:
- **Subdomain** — e.g. `sniper.yourdomain.com` (used to lock the Nginx `server_name`)
- **Master Password** — used to protect the dashboard login

The script writes a `.env` file, stops any running containers, rebuilds images with `--no-cache`, and starts everything in detached mode. The dashboard is available at `http://<your-domain>:8080`.

To view live logs after deployment:

```bash
docker compose logs -f
```

## User Setup (Dashboard)

1. **Login** with the master password.
2. **Add a user** — provide a WhatsApp phone number (ID), a name/payload to send, the target group ID, and a delay tier (milliseconds).
3. **Connect** — scan the QR code or use a pairing code to authenticate the WhatsApp session.
4. The bot auto-warms the group session on connect and displays **SNIPER ARMED** when ready.

## Sniper Window

- **Days:** Monday – Friday only
- **Time:** 3:58 PM – 4:05 PM (Africa/Lagos, WAT / UTC+1)
- **Trigger:** Group `announce` flag changes to `false` (group unlocked)
- **Rate limit:** One fire per user per calendar day

## Fire Speed

The fire path lives in `backend/sniper.ts`:

- **Raw unlock trigger** — listens for the `w:gp2` / `not_announcement` notification straight off the socket, before Baileys converts it into a `groups.update` event (kept as a backup trigger).
- **Pre-window warmup** — on connect, on config change and every weekday at 15:56 it loads group members, their devices and an encryption session with every device, so the send needs no extra round trips.
- **In-memory key store** — encryption keys are read from memory; disk writes happen in the background.
- **Direct relay** — sends a plain text message with `relayMessage` (no link-preview lookup, no own-message re-processing).
- **Quiet connection** — background metadata refreshes are skipped during the window.
- **Timing logs** — each fire logs unlock receive time, send write time, and server ack RTT.
- **Persistent daily lock** — `users.last_fired_day` stops a restart from firing twice in one day.

### Burst mode (experimental, off by default)

Sends a few times around a predicted unlock time instead of waiting for the notification. Saves roughly one network hop, but risks duplicate posts and WhatsApp flagging repeated rejected sends. Use only if the timing logs show the unlock happens at the same moment every day.

| Variable | Default | Meaning |
|---|---|---|
| `SNIPER_BURST_ENABLED` | `false` | Turn burst mode on |
| `SNIPER_BURST_AT` | `16:00:00.000` | Predicted unlock time (Lagos) |
| `SNIPER_BURST_LEAD_MS` | `150` | Start this many ms before `SNIPER_BURST_AT` |
| `SNIPER_BURST_COUNT` | `5` | Number of attempts |
| `SNIPER_BURST_GAP_MS` | `40` | Gap between attempts |

The burst stops at the first accepted send. If the unlock notification arrives first, the bot waits (up to 1.5s) for in-flight burst acks before firing normally, so it never posts twice.

## Data Persistence

Session credentials and the SQLite database are mounted as Docker volumes so they survive container restarts:

```
./backend/sessions  →  /app/sessions   (Baileys auth state per user)
./backend/data      →  /app/data       (users.db)
```

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/users` | Add or update a user config |
| `GET` | `/api/users` | List all users |
| `GET` | `/api/session/status/:userId` | Check if a user's WA session is live |
| `DELETE` | `/api/session/:userId` | Disconnect user, delete session and DB record |
| `GET` | `/api/groups/:userId` | Fetch groups the user is a member of |
| `POST` | `/api/test-fire` | Send a test `.` message to a group immediately |

## Socket.IO Events

| Event | Direction | Description |
|---|---|---|
| `start-session` | Client → Server | Initiate WA login for a userId |
| `qr-{userId}` | Server → Client | Base64 QR code data URL |
| `pairing-code-{userId}` | Server → Client | Pairing code string |
| `ready-{userId}` | Server → Client | Session authenticated |
| `armed-{userId}` | Server → Client | Sniper warmed and armed |
| `sniper-log-{userId}` | Server → Client | Real-time log entry `{ level, message }` |
| `error-{userId}` | Server → Client | Session error message |

## Environment Variables

| Variable | Description |
|---|---|
| `MASTER_PASSWORD` | Dashboard login password |
| `NEXT_PUBLIC_API_URL` | API base URL (leave empty — Nginx handles routing) |
| `NODE_ENV` | `production` |
| `PORT` | Backend port (default `8000`) |
