# Discord Channel Implementation Summary

## What Was Added

### 1. Discord Channel (`src/channels/discord.ts`)
- Full Discord bot implementation using discord.js
- Supports text-based channels (DMs, text channels, threads)
- Message streaming with edit support
- User allowlist filtering
- Handles message splitting for Discord's 2000 char limit

### 2. Channel Manager (`src/channels/manager.ts`)
- Automatic rate limit detection and fallback
- Per-chat channel tracking
- Configurable rate limits per channel
- Prevents circular message loops

### 3. Configuration Updates
- Added `DISCORD_BOT_TOKEN` and `DISCORD_ALLOW_FROM` to config schema
- Updated `.env.example` with Discord settings
- Modified gateway mode to support multiple channels

### 4. Documentation
- Created `docs/DISCORD.md` with setup instructions
- Updated main README with Discord fallback info

## How It Works

1. **Gateway starts** with both Telegram and Discord channels (if configured)
2. **Channel Manager** intercepts outbound messages
3. **Rate limit check**: 
   - Telegram: 20 messages/minute
   - Discord: 50 messages/minute
4. **Automatic fallback**: If Telegram is rate limited, messages route to Discord
5. **Per-chat tracking**: Each chat remembers which channel it's using

## Rate Limit Strategy

The manager tracks message timestamps per channel:
- Maintains a sliding window of recent messages
- Counts messages within the rate limit window
- Switches to fallback when limit exceeded
- Automatically switches back when window resets

## Files Modified

- `src/channels/discord.ts` (new)
- `src/channels/manager.ts` (new)
- `src/config/schema.ts` (updated)
- `src/index.ts` (updated gateway mode)
- `.env.example` (updated)
- `README.md` (updated)
- `docs/DISCORD.md` (new)
- `package.json` (added discord.js dependency)

## Testing

To test the implementation:

1. Configure both tokens in `.env`:
   ```env
   TELEGRAM_BOT_TOKEN=your-telegram-token
   TELEGRAM_ALLOW_FROM=your-username
   DISCORD_BOT_TOKEN=your-discord-token
   DISCORD_ALLOW_FROM=your-user-id
   ```

2. Start gateway:
   ```bash
   bun run src/index.ts gateway
   ```

3. Send messages rapidly to trigger rate limit and observe automatic fallback

## Notes

- Discord commands work the same as Telegram (except `/gemini` and `/double`)
- The manager modifies messages in-place to avoid circular republishing
- Rate limits are conservative and can be adjusted in `src/index.ts`
- Both channels can run simultaneously - they're independent
