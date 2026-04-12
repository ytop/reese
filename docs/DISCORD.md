# Discord Integration

Reese supports Discord as a fallback channel when Telegram hits rate limits.

## Setup

1. Create a Discord bot:
   - Go to https://discord.com/developers/applications
   - Click "New Application"
   - Go to "Bot" tab and click "Add Bot"
   - Copy the bot token

2. Enable Privileged Gateway Intents:
   - Go to the "Bot" tab in your application
   - Scroll down to "Privileged Gateway Intents"
   - Enable **Message Content Intent** (This is required for the bot to read your messages)
   - Click "Save Changes"

3. Add bot to your server:
   - Go to OAuth2 → URL Generator
   - Select scopes: `bot`
   - Select permissions: `Send Messages`, `Read Messages/View Channels`, `Read Message History`
   - Copy the generated URL and open it in your browser
   - Select your server and authorize

4. Configure `.env`:
   ```env
   DISCORD_BOT_TOKEN=your-bot-token-here
   DISCORD_ALLOW_FROM=user_id1,user_id2
   ```

5. Get your Discord user ID:
   - Enable Developer Mode in Discord (Settings → Advanced → Developer Mode)
   - Right-click your username and select "Copy ID"

## How It Works

When you run `reese gateway` with both Telegram and Discord configured:

1. **Primary channel**: Telegram (20 messages/minute limit)
2. **Fallback channel**: Discord (50 messages/minute limit)

If Telegram hits its rate limit, messages automatically switch to Discord for that chat. The system tracks rate limits per channel and switches back when limits reset.

## Rate Limits

- **Telegram**: 20 messages per minute
- **Discord**: 50 messages per minute

These are conservative defaults. Adjust in `src/index.ts` if needed.

## Commands

Discord supports the same commands as Telegram:
- `/new` - Start new conversation
- `/end` - Stop current task
- `/dream` - Run memory consolidation
- `/status` - Show session info
- `/help` - Show help

Note: `/gemini` and `/double` are Telegram-only features.
