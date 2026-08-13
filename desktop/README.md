# Gitu Desktop

A native desktop client for the **Gitu** AI assistant. It embeds the existing
web UI (chat with streaming, tool cards, model switcher, autonomous-loop
trace) in an Electron window and adds desktop conveniences:

- **Backend lifecycle** — attaches to a Gitu backend that is already running
  (e.g. PM2, `node dist/index.js`, Docker) or starts `node dist/index.js`
  from the repo root automatically when nothing is listening on port 3000.
- **Tray icon** — show/hide the window, open the UI in a browser, restart the
  backend, open the backend log, toggle launch-at-login, quit.
- **Native notifications** — when Gitu finishes a reply while the window is
  hidden or unfocused, a system notification appears (clicking it reopens
  the window).
- **Hide-to-tray** — closing the window keeps the app running; use
  **Quit Gitu** in the tray (or Ctrl/Cmd+Q) to exit.
- **Owned-backend safety** — if the desktop app started the backend itself it
  shuts it down on quit; if you run the backend separately, it is left alone.

## Requirements

- Node.js >= 22.5 (matching the repo)
- A built backend: `node dist/index.js` must exist. If `dist/` is stale, run
  `npx tsc` from the repo root first.

## Install & run

```bash
cd desktop
npm install     # installs Electron (~100 MB, one time)
npm start
```

The window opens, and the tray icon appears next to the clock. The first time
you sign in you use the same username/password as the web UI
(`/auth/login` on the backend; tokens are stored per-user in `users.json`).

## Configuration (environment variables)

| Variable | Default | Purpose |
| --- | --- | --- |
| `GITU_DESKTOP_URL` | `http://127.0.0.1:3000` | Full URL to connect to. Remote servers work; auto-spawn is disabled for them. |
| `GITU_DESKTOP_PORT` | `3000` | Port to probe / spawn on when the URL is not set. |
| `GITU_DESKTOP_AUTOSTART` | `1` | Set to `0`/`false` to never spawn the backend — only attach. |

Example (attach to a server elsewhere):

```bash
GITU_DESKTOP_URL=https://gitu.example.com npm start
```

## Logs & debugging

- Backend output when spawned by the desktop app: `logs/desktop-backend.log`
  (repo root). Tray → *Open backend log* jumps there.
- Main-process errors print to the terminal where you ran `npm start`.
- In the window: **Ctrl+Shift+I** opens DevTools, **Ctrl+R** reloads.

## Verification

```bash
cd desktop
npm run smoke   # launches the app, waits for the backend, exits 0 on success
```

## Packaging (optional)

For installers / standalone binaries:

```bash
cd desktop
npx electron-builder --win --mac --linux
```

(`electron-builder` is intentionally not a dependency here — add it when you
want to build distributables.)

## How it works

```
desktop/main.js     Electron main process: window, tray, backend attach/spawn,
                    notifications, single-instance lock, Ctrl/Cmd+Q.
desktop/preload.js  Sandboxed preload: MutationObserver on the chat DOM — when
                    an assistant message finishes streaming (the cursor class
                    disappears) it pings the main process over IPC.
desktop/splash.html Minimal loading screen shown while the backend warms up.
```

The renderer loads the existing Gitu web UI as-is; no UI code was duplicated
or modified.
