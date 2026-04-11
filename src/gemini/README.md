# Gemini Integration for Reese

A minimal Gemini API integration for Reese that can be invoked via the Telegram gateway channel.

## Features

- **No UI**: Headless operation only
- **No slash commands in TUI**: Only available via Telegram `/gemini` command
- **No authorization**: Authorization is handled externally by Telegram channel
- **Silent mode**: Always operates with maximum privilege
- **Request/Response**: Simple synchronous query interface
- **Gateway integration**: Invokable from Reese Telegram bot

## Architecture

```
src/gemini/
├── client.ts    # Core Gemini API client
├── handler.ts   # Message bus integration
└── index.ts     # Public exports
```

### Components

1. **GeminiClient** (`client.ts`)
   - Direct Gemini API communication
   - Handles request/response formatting
   - Supports conversation history
   - Error handling

2. **GeminiHandler** (`handler.ts`)
   - Integrates with Reese message bus
   - Listens for `gemini:request` events
   - Emits `gemini:response` events
   - Logging integration

3. **Telegram Integration** (`channels/telegram.ts`)
   - `/gemini <prompt>` command
   - Automatic typing indicators
   - Markdown formatting
   - Error handling

## Configuration

Add to your `.env`:

```env
# Gemini integration (optional)
GEMINI_MODEL=gemini-2.0-flash-exp
GEMINI_API_BASE=https://generativelanguage.googleapis.com/v1beta
```

Create `workspace/.gemini-oauth.json` with your OAuth token:

```json
{
  "access_token": "your-oauth-access-token",
  "refresh_token": "your-refresh-token",
  "expires_at": 1712865120000
}
```

The OAuth token is obtained from your external Gemini authentication. Reese reads the token directly from the config file.

## Usage

### Via Telegram

1. Start Reese in gateway mode:
   ```bash
   reese gateway
   ```

2. In Telegram, use the `/gemini` command:
   ```
   /gemini What is the capital of France?
   ```

### Programmatic Usage

```typescript
import { GeminiClient, GeminiOAuthProvider } from "./gemini/index.js";

const oauthProvider = new GeminiOAuthProvider("./workspace");

const client = new GeminiClient({
  getAccessToken: () => oauthProvider.getAccessToken(),
  model: "gemini-2.0-flash-exp",
});

const response = await client.generate({
  prompt: "Hello, Gemini!",
  history: [], // optional conversation history
});

console.log(response.content);
```

## Message Bus Events

### Request Event
```typescript
bus.emit("gemini:request", {
  prompt: string,
  history?: ChatMessage[],
  replyTo: {
    chatId: string,
    senderId: string,
    messageId?: number,
  },
});
```

### Response Event
```typescript
bus.emit("gemini:response", {
  content: string,
  error: boolean,
  replyTo: {
    chatId: string,
    senderId: string,
    messageId?: number,
  },
});
```

## Tech Stack

- **Bun**: Runtime (same as Reese)
- **TypeScript**: Type safety
- **Fetch API**: HTTP client (native)
- **Message Bus**: Event-driven architecture (Reese's bus)

## Limitations

1. No streaming support (simple request/response only)
2. No tool calling (pure text generation)
3. No system instructions customization
4. No temperature/parameter tuning via commands
5. No conversation persistence (stateless)

## Future Enhancements

If needed, these could be added:

- [ ] Streaming responses
- [ ] Tool calling support
- [ ] Conversation history persistence
- [ ] Custom system instructions
- [ ] Parameter tuning
- [ ] Multi-modal support (images)
- [ ] Token usage tracking
- [ ] Rate limiting

## License

Same as Reese (see root LICENSE)
