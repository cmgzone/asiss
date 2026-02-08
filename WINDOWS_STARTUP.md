# Run GituAI on Boot (Windows)

If you want Playwright automation to be visible (real browser window), GituAI must run in your **interactive desktop session**. The easiest way is a Scheduled Task that runs **at logon**.

## 1) Install dependencies (one-time)

From the repo root:

```powershell
npm ci
```

If Playwright browsers are missing:

```powershell
npm run playwright:install
```

## 2) Install startup task (runs at logon)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\install-startup-task.ps1
```

Optional (run elevated / admin):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\install-startup-task.ps1 -RunAsAdmin
```

## 3) Remove startup task

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\uninstall-startup-task.ps1
```

## Notes (Why you may not see the browser)

- **Visible mode needs `headless:false`** in the Playwright tool call.
- If Windows runs GituAI as a service or “Run whether user is logged on or not”, the browser may open in a hidden session.
- Using Task Scheduler with interactive logon avoids that.

