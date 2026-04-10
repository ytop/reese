# Logging System

The agent now includes comprehensive logging that writes to a file and sends important events to Telegram in gateway mode.

## Features

All major agent events are logged:

- **Message received** - When a user sends a message
- **LLM calls** - Model name, message count, token estimate
- **LLM responses** - Stop reason, tools used, response length
- **Tool execution** - Which tools are being executed
- **Skills loading** - When skills are loaded into context
- **Agent lifecycle** - Start/stop events
- **Errors** - Any errors during processing

## Log Destinations

### File Logging
All logs are written to `workspace/agent.log` with timestamps, levels, and categories:

```
[2026-04-10T08:39:13.612Z] [INFO] [System] Agent started in gateway mode (model: gpt-4o)
[2026-04-10T08:39:15.123Z] [INFO] [Message] Received from telegram:123456789 — "Hello, how are you?"
[2026-04-10T08:39:15.456Z] [INFO] [LLM] Calling model=gpt-4o, messages=5, tokens~1234
[2026-04-10T08:39:17.789Z] [INFO] [Tools] Executing 2 tool(s): read_file, write_file
[2026-04-10T08:39:18.012Z] [INFO] [LLM] Response received — stopReason=completed, tools=[read_file,write_file], length=256
```

### Telegram Logging (Gateway Mode Only)
In gateway mode, logs are also sent to Telegram with emoji indicators:
- ℹ️ Info messages
- ⚠️ Warnings
- 🔴 Errors

Debug-level logs are only written to file, not sent to Telegram.

## Configuration

Add to your `.env`:

```env
# Optional: specific chat ID to send logs to
TELEGRAM_LOG_CHAT_ID=123456789
```

If not set, logs default to the first user in `TELEGRAM_ALLOW_FROM`.

## Log Levels

- **debug** - Detailed bus message flow (file only)
- **info** - Normal operations (file + Telegram)
- **warn** - Warnings (file + Telegram)
- **error** - Errors (file + Telegram)

## Implementation

The logging system is implemented in `src/logger.ts` as a singleton that:
1. Writes all logs to `workspace/agent.log`
2. Optionally sends non-debug logs to Telegram via the message bus
3. Handles errors gracefully if logging fails

Logging is integrated into:
- `src/index.ts` - Initialization
- `src/agent/loop.ts` - Message processing and LLM calls
- `src/agent/runner.ts` - Tool execution and errors
- `src/agent/skills.ts` - Skill loading
- `src/bus/queue.ts` - Message bus events
