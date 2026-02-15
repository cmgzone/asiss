# Gitu 24/7 Autonomous Operation Guide

This document explains how to run Gitu as a fully autonomous 24/7 assistant.

## Quick Start

```bash
# Install PM2 globally (one time)
npm install -g pm2

# Start Gitu in production mode
npm run start:prod

# Check status
npm run status

# View logs
npm run logs

# Restart
npm run restart

# Stop
npm run stop
```

## Features

### 1. Background Goals
Queue tasks for Gitu to work on while you're away:

```
/goal Research competitors - Find and summarize the top 5 competitors in our market
/goals   # List all goals
```

- Goals run automatically when you've been idle for 5 minutes
- Progress is tracked and saved
- You get notified when tasks complete
- Optional: set `backgroundWorker.alwaysOn: true` to run even while you are active
- Optional: set `backgroundWorker.reportIntervalMs` to send periodic status updates

### 2. Do Not Disturb (Quiet Hours)
Gitu respects your sleep:

```
/dnd     # Check current DND status
```

**Config in `config.json`:**
```json
"dnd": {
  "enabled": true,
  "quietHoursStart": 22,  // 10 PM
  "quietHoursEnd": 8,     // 8 AM
  "allowUrgent": true     // Urgent alerts bypass DND
}
```

During quiet hours:
- Non-urgent notifications are queued
- Background tasks pause (unless urgent)
- Queued notifications are delivered when you wake up

### 3. Scheduled Tasks
```
/schedule 10m Check my emails      # Run in 10 minutes
/schedule 2h Send daily report     # Run in 2 hours
/every 1h Check for new messages   # Run every hour
/jobs                              # List all scheduled jobs
/cancel <job-id>                   # Cancel a job
```

### 4. Proactive Check-ins
When enabled, Gitu will check in if:
- You've been idle for 5+ minutes
- There's something helpful to say
- It's not during quiet hours

**Config:**
```json
"proactive": {
  "enabled": true,
  "idleMs": 300000,      // 5 min idle threshold
  "minGapMs": 600000,    // 10 min between check-ins
  "everyMs": 60000       // Check every 1 min
}
```

## Configuration Reference

All settings in `config.json`:

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `proactive.enabled` | boolean | false | Enable proactive check-ins |
| `proactive.idleMs` | number | 300000 | Idle time before check-in (ms) |
| `proactive.minGapMs` | number | 600000 | Min gap between check-ins (ms) |
| `dnd.enabled` | boolean | false | Enable quiet hours |
| `dnd.quietHoursStart` | number | 22 | Quiet hours start (0-23) |
| `dnd.quietHoursEnd` | number | 8 | Quiet hours end (0-23) |
| `dnd.allowUrgent` | boolean | true | Allow urgent through DND |
| `backgroundWorker.enabled` | boolean | false | Enable background goals |
| `backgroundWorker.alwaysOn` | boolean | false | Run goals even when user is active |
| `backgroundWorker.maxConcurrentGoals` | number | 1 | Max parallel goals |
| `backgroundWorker.idleThresholdMs` | number | 300000 | Idle time before starting work |
| `backgroundWorker.respectDND` | boolean | true | Pause during quiet hours |
| `backgroundWorker.reportIntervalMs` | number | 0 | Periodic status updates (ms); 0 disables |

## PM2 Management

### View Logs
```bash
pm2 logs gitu --lines 100
```

### Monitor Resources
```bash
pm2 monit
```

### Auto-start on Boot
```bash
pm2 startup
pm2 save
```

### Restart Strategies
The `ecosystem.config.js` includes:
- Auto-restart on crash
- Memory limit (500MB)
- Daily restart at 4 AM (memory cleanup)
- Log rotation

## Troubleshooting

### Gitu not starting?
```bash
pm2 logs gitu --err --lines 50
```

### Background tasks not running?
1. Check `config.json` has `backgroundWorker.enabled: true`
2. Make sure you've been idle long enough
3. Check if it's quiet hours (`/dnd`)

### Notifications not arriving?
1. Check if in DND mode
2. When you send a message, queued notifications are delivered
3. Or wait until quiet hours end
