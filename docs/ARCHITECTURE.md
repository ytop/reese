# Discord Fallback Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Gateway Mode                            │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │   MessageBus     │
                    │  (Event Queue)   │
                    └──────────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │ ChannelManager   │
                    │ - Rate tracking  │
                    │ - Auto fallback  │
                    └──────────────────┘
                              │
                ┌─────────────┴─────────────┐
                ▼                           ▼
      ┌──────────────────┐        ┌──────────────────┐
      │ TelegramChannel  │        │  DiscordChannel  │
      │ 20 msg/min       │        │  50 msg/min      │
      └──────────────────┘        └──────────────────┘
                │                           │
                ▼                           ▼
         [Telegram API]            [Discord API]
```

## Message Flow

### Normal Operation (Telegram)
```
User → Telegram → TelegramChannel → MessageBus → AgentLoop
                                                      │
AgentLoop → MessageBus → ChannelManager → TelegramChannel → User
                              │
                              └─ Rate check: OK ✓
```

### Rate Limited (Fallback to Discord)
```
User → Telegram → TelegramChannel → MessageBus → AgentLoop
                                                      │
AgentLoop → MessageBus → ChannelManager → DiscordChannel → User
                              │
                              ├─ Rate check: Telegram FULL ✗
                              └─ Fallback: Discord OK ✓
```

## Rate Limit Tracking

```typescript
// Per-channel message timestamps
messageCounts = {
  "telegram": [timestamp1, timestamp2, ...],  // Last 20 messages
  "discord": [timestamp1, timestamp2, ...]    // Last 50 messages
}

// Sliding window check
function isRateLimited(channel) {
  const recent = timestamps.filter(t => now - t < 60000);
  return recent.length >= maxMessages;
}
```

## Key Features

1. **Transparent Fallback**: Users don't need to do anything - messages automatically route to available channel

2. **Per-Chat Tracking**: Each conversation remembers which channel it's using

3. **Automatic Recovery**: When rate limits reset, system can switch back to primary channel

4. **No Message Loss**: If both channels are rate limited, messages queue until capacity available

5. **Independent Channels**: Both Telegram and Discord run simultaneously, handling their own inbound messages
