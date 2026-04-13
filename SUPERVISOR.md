# Gateway Supervisor Implementation

## Overview

The supervisor allows you to control the `reese gateway` via Telegram commands without losing the Telegram connection. The supervisor runs as a persistent process that spawns the gateway as a child process.

## Architecture

**Standalone Gateway Mode:**
```
┌─────────────────────────────────────┐
│   Gateway (reese gateway)           │
│   - Handles all Telegram messages   │
│   - Runs agent loop                 │
│   - /gateway command disabled       │
└─────────────────────────────────────┘
```

**Supervisor Mode:**
```
┌─────────────────────────────────────┐
│   Supervisor (persistent)           │
│   - Watches for .gateway.restart    │
│   - Manages gateway lifecycle       │
│   - Auto-restarts on crash          │
└──────────────┬──────────────────────┘
               │ spawns/controls
               ▼
┌─────────────────────────────────────┐
│   Gateway (child process)           │
│   - Handles Telegram messages       │
│   - Runs agent loop                 │
│   - /gateway writes restart flag    │
│   - SUPERVISOR_MODE=1 env var       │
└─────────────────────────────────────┘
         │
         └─> Both use same Telegram bot token
```

## Files Created

1. **src/supervisor.ts** - Main supervisor process
   - Spawns gateway as child process
   - Handles Telegram commands: `/gateway`, `/status`, `/stop`, `/start`
   - Auto-restarts gateway on crash
   - Respects `TELEGRAM_ALLOW_FROM` for access control

2. **install-supervisor.sh** - Systemd installation script
   - Installs supervisor as systemd service
   - Auto-starts on boot
   - Configures proper user and working directory

3. **reese-supervisor.service** - Systemd service template

## Usage

### Local Development

```bash
# Start supervisor manually
reese supervisor

# Or with bun directly
bun run src/index.ts supervisor
```

### Production (Ubuntu/systemd)

```bash
# Install as systemd service
./install-supervisor.sh

# View logs
journalctl -u reese-supervisor -f

# Control service
sudo systemctl status reese-supervisor
sudo systemctl restart reese-supervisor
sudo systemctl stop reese-supervisor
```

## Discord Commands

Once the supervisor is running, use these commands in Discord:

**Supervisor control commands:**
- `!status` — Check if gateway is running (shows PID)
- `!start` — Start the gateway
- `!stop` — Stop the gateway
- `!restart` / `!gateway` — Restart the gateway
- `!shell <cmd>` — Run a shell command from the repo root and return output
- `!help` — Show all supervisor commands

**Agent commands (handled by gateway):**
- `/new` - Start a new conversation
- `/end` - Stop the current task
- `/dream` - Run memory consolidation
- `/help` - Show available commands

### `!shell` examples

```
!shell ls -la workspace/
!shell bun run src/index.ts --help
!shell git log --oneline -5
!shell cd app && bun cli.tsx list
```

Output (stdout + stderr) is sent back to the same Discord channel. Responses longer than ~1900 characters are automatically truncated.

## Key Features

1. **Persistent Connection** - Supervisor maintains Telegram connection while gateway restarts
2. **Auto-Recovery** - Automatically restarts gateway if it crashes
3. **Access Control** - Respects `TELEGRAM_ALLOW_FROM` configuration
4. **Graceful Shutdown** - Sends SIGTERM, waits 10s, then SIGKILL if needed
5. **Notifications** - Sends Telegram messages on crash/restart

## Configuration

Uses existing `.env` configuration:
- `TELEGRAM_BOT_TOKEN` - Required
- `TELEGRAM_ALLOW_FROM` - Optional, restricts who can use control commands
- `TELEGRAM_LOG_CHAT_ID` - Optional, where to send crash notifications

## How It Works

1. Supervisor starts and spawns gateway as child process (with `SUPERVISOR_MODE=1` env var)
2. Both supervisor and gateway listen to the same Telegram bot
3. When `/gateway` is received in Telegram:
   - Gateway handler writes `.gateway.restart` flag file
   - Gateway replies "Restart signal sent..."
   - Supervisor detects the flag file
   - Supervisor sends SIGTERM to gateway process
   - Waits for clean exit (max 10s)
   - Spawns new gateway process
   - Sends "Restarted!" confirmation
4. Gateway connection drops briefly (1-2s) during restart
5. All other commands work normally through the gateway

## Testing

```bash
# Test help text
reese --help

# Test supervisor starts (Ctrl+C to stop)
reese supervisor

# In Telegram, test commands:
/status      # Shows gateway PID
/gateway     # Restarts gateway (connection drops briefly)
/status      # Shows new PID
```

## Switching Between Modes

**Standalone gateway** (no restart capability):
```bash
reese gateway
```
- `/gateway` command shows: "⚠️ Gateway restart is only available in supervisor mode"

**Supervisor mode** (with restart capability):
```bash
reese supervisor
```
- `/gateway` command works and restarts the gateway
- `/status`, `/stop`, `/start` commands available
