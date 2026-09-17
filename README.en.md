<div align="center">

# kabby

**One Claude Code process, many windows attached — a PTY multiplexer for cc.**

Your desktop app, a browser tab, your phone and an embedded iframe all see the same terminal. Close the window and cc keeps running.

</div>

---

![kabby Web UI — tabs, project/running list on the left, live panel and monitor entry at top right](docs/images/screenshot.png)

<div align="center">

**English** · [繁體中文](./README.md) · [简体中文](./README.zh-CN.md)

</div>

## What is Kabby

When you start Claude Code in a terminal, the cc process is tied to that window: close the window or drop the SSH connection and the session is gone. Want to pick it up on another device? Your only option is to start a fresh cc.

kabby separates the **cc process** from the **client connection**. cc runs in a PTY inside the daemon, and any client — the desktop app, a browser tab, a wepages iframe, your phone's browser — attaches over WebSocket and sees the same screen and the same scrollback. It behaves like `tmux attach`, except the entry point is a URL instead of a terminal.

Three features grow out of that: turn a session into a **chat room** so others can watch or work alongside you, reach the cc on your home machine **remotely** through a tunnel, and **analyze** your cc history for token usage and cost.

kabby itself is Node.js with four dependencies (express / ws / node-pty / cors). No database — sessions live in memory, settings live in `~/.kabby/`.

## Installation

Requires **Node.js ≥ 18** and the [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI (Codex works too).

```bash
git clone https://github.com/jokerjkeeper/kabby.git
cd kabby
npm install
npm start
# → kabby daemon listening on http://localhost:3700
```

Open `http://localhost:3700` for the full UI. On Windows `node-pty` uses the prebuilt ConPTY backend, so a plain `npm install` is enough — no build toolchain needed.

Auto-restart while developing:

```bash
npm run dev
```

**Desktop app (optional)** — an Electron shell; just a window pointed at the daemon:

```bash
cd desktop
npm install
npm start           # dev
npm run dist        # build a Windows portable exe
```

### Configuration

Environment variables (put them in `.env`; see `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3700` | Shared HTTP + WS port |
| `HOST` | `127.0.0.1` | Bind address; set `0.0.0.0` to allow LAN access (always pair it with `AUTH_TOKEN`) |
| `AUTH_TOKEN` | (unset) | Once set, WS connections must pass `?token=<value>` |
| `KABBY_VIEWER_PATH` | (unset) | Absolute path to the cc history viewer executable; enables the "viewer" button in the UI |

User data lives in `~/.kabby/`: `profiles.json` (project list), `sensitive-words.json` (blocklist), and the usage index.

## Features

### Multi-client attach (the core)

- **One PTY, N clients**: a new client receives a scrollback replay first, then the live stream — no need to restart cc
- **Projects (profiles)**: save a working directory as a card, then "New chat" or "Resume" in one click — the latter reattaches cc's own previous session
- **Tabs and split panes**: `Ctrl+Shift+←/→` to switch tabs, `Ctrl+Shift+D/E` to split horizontally/vertically; each pane is its own session
- **Providers**: launch either Claude Code or Codex, chosen when the session is created
- **Input blocklist**: outgoing input is matched against a word list server-side; a hit is dropped before it reaches the PTY

### Chat

The chat button at the top right opens a side panel: create a room, bind it to a running session, set an entry key.

![Create room dialog: bind session, room name, entry key, and the "allow guest input" toggle](docs/images/room-create.png)

Guests open `http://<host>:3700/room.html` (or a copied link carrying `?key=`), enter the key and a nickname, and they are in:

- **Watch the terminal**: the bound session's live screen including scrollback replay, following the host's terminal size
- **Text chat**: last 200 messages; supports **images** (Ctrl+V a screenshot or pick a file — compressed client-side, sent over WS, kept in memory, 20 most recent per room) and **@mentions** (autocomplete over room members, highlights the person tagged)
- **Permissions**: each room has an input toggle that is **read-only by default**; the host can flip it live, and the read-only check is enforced server-side, not hidden in the frontend
- **Isolation**: a guest key only grants the WS of that room's bound session plus chat — no other API is reachable
- Rooms live in memory; restarting the daemon or ending the bound session closes them

> ⚠ Enabling guest input lets visitors run arbitrary commands on this machine with your permissions. Only hand the key to people you trust.

### Remote

Bound to `127.0.0.1`, the daemon is local-only. Two ways to reach your cc from outside:

- **LAN**: `HOST=0.0.0.0` plus `AUTH_TOKEN`, then connect to `http://<lan-ip>:3700` from a phone or laptop on the same network
- **Cloudflare Tunnel (recommended)**: keep the daemon on `127.0.0.1` and let the tunnel expose it as `https://kabby.your-domain` over 443, with no inbound firewall rule. Setup: [`docs/cloudflare-tunnel.html`](./docs/cloudflare-tunnel.html)

Pair it with [`docs/deploy-systemd.md`](./docs/deploy-systemd.md) to run the daemon as a systemd service — starts on boot, restarts on crash, survives SSH disconnects. That gives you an always-on cc host you can check from a phone browser whenever you want.

`embed.html` is a stripped-down terminal page meant to be iframed into your own task/ticket system (see [`docs/wepages-phase3-integration.md`](./docs/wepages-phase3-integration.md)).

### Session Analyze

The monitor button opens a read-only analytics panel; a background watcher keeps indexing Claude Code / Codex history jsonl files.

![Monitor panel: totals row plus the token usage tab listing model, turns, tokens, cost and last activity per session](docs/images/monitor.png)

- Totals: sessions, turns, input/output tokens, cache writes and reads, **estimated cost**, blocklist hits
- **Token usage**: per session — model, turns, tokens, cost, last activity — expandable to per-turn detail, so you can spot the turn where context blew up
- **Live**: per-turn usage of the session running right now
- **Dashboard**: aggregate view
- **Blocklist**: hit list; the word list lives in `~/.kabby/sensitive-words.json`
- Switch **Claude / Codex** at the top right; refresh re-reads the index, while rescan drops it and scans from scratch (recomputing tokens/cost and applying the current word list to old conversations)

Indexing and pricing are computed locally — your conversations are never sent anywhere.

## API

```bash
# create a session
curl -X POST http://localhost:3700/api/sessions \
  -H "Content-Type: application/json" \
  -d '{"name":"unity","cwd":"D:/Projects/my-app"}'

# list sessions
curl http://localhost:3700/api/sessions

# attach with any WS client, e.g. wscat
wscat -c ws://localhost:3700/ws/unity
```

Full HTTP + WS reference: [`docs/api.md`](./docs/api.md) · Step-by-step usage and troubleshooting: [`docs/usage.md`](./docs/usage.md)

## Testing

```bash
node test/smoke.js
```

Runs `cmd.exe` in place of cc (so it does not depend on claude being installed) and verifies: creating/deleting sessions over the HTTP API, fan-out between two WS clients on one session, scrollback replay for a third client joining later, and `clientCount` tracking attachments correctly.

## Architecture

```
client (desktop app / browser / iframe / room.html)
        │  WebSocket  ws://host:3700/ws/<session>
        ▼
   daemon.js ── HTTP API + WS upgrade + fan-out
        │
   Session ── node-pty (one cc process) + ring buffer (scrollback)
```

```
src/
  daemon.js        — entry: HTTP server + WS upgrade + API routes
  session.js       — Session class: wraps PTY + scrollback + clients
  registry.js      — singleton Map<id, Session>, name dedupe, ccSessionId lookup
  ring-buffer.js   — 100KB chunk-based ring buffer
  room-registry.js — chat rooms: rooms, entry keys, members, messages
  profile-store.js — ~/.kabby/profiles.json CRUD
  usage-watcher.js — background scan of history jsonl into a usage index
  cc-history.js    — cc conversation jsonl parser
  sensitive.js     — blocklist matching
public/            — web UI (SPA + room.html + embed.html)
desktop/           — Electron desktop client
docs/              — API, usage, deployment (tunnel / systemd)
PLAN.md            — design decisions and phased plan
```

Design decisions and phase details: [`PLAN.md`](./PLAN.md).

## License

MIT
