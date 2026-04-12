# /double Command Implementation

## Overview

The `/double` command enables parallel dual-agent processing with cross-review in Telegram. It runs two LLM agents simultaneously (default model and think model), then performs a cross-review where each agent reviews the other's response.

## Architecture

### Flow

1. **Parallel Execution**: User sends `/double <message>`
   - Main agent uses default model + main session file
   - Think agent uses think model + secondary session file (`{sessionKey}:secondary`)
   
2. **Initial Responses**: Both agents process the message independently and send responses to Telegram with agent labels:
   - 🤖 Main Agent: `<response>`
   - 🧠 Think Agent: `<response>`

3. **Cross-Review Round 1**: Each agent reviews the other's response
   - Main agent reviews Think's response
   - Think agent reviews Main's response
   - Both reviews sent to Telegram with labels

4. **Session Management**:
   - Main session: `telegram:{chatId}` (standard session)
   - Secondary session: `telegram:{chatId}:secondary` (new session file)
   - Each maintains independent conversation history and compact context

## Files Modified

### `/src/channels/telegram.ts`
- Added `/double` to command list in help text
- Added `/double` to bot command menu
- Updated command handler to pass full text for `/double`

### `/src/agent/loop.ts`
- Added `handleDoubleCommand()` - orchestrates parallel execution and cross-review
- Added `runAgent()` - runs a single agent with session management
- Added `runCrossReview()` - runs cross-review for one agent
- Updated `handleCommand()` to route `/double` commands
- Imported `Session` type from session manager

## Usage

```bash
# In Telegram
/double What is the best approach to implement a binary search tree?
```

## Response Format

```
🤖 Main Agent:
[Main agent's response to the question]

🧠 Think Agent:
[Think agent's response to the question]

🤖 Main Agent Review:
[Main agent's review of Think agent's response]

🧠 Think Agent Review:
[Think agent's review of Main agent's response]
```

## Configuration

The think model is configured via environment variables in `.env`:

```env
# Think model (optional — for /think and /double commands)
THINK_MODEL_API_KEY=sk-...
THINK_MODEL_API_BASE=https://api.openai.com/v1
THINK_MODEL_NAME=o1-preview
```

If think model is not configured, both agents will use the default model.

## Session Files

- Main session: `workspace/sessions/telegram_{chatId}.json`
- Secondary session: `workspace/sessions/telegram_{chatId}_secondary.json`

Each session maintains:
- Message history
- Compact context
- Metadata
- Last consolidated timestamp

## Benefits

1. **Diverse Perspectives**: Two different models/approaches to the same problem
2. **Quality Control**: Cross-review helps identify gaps or errors
3. **Parallel Processing**: Both agents run simultaneously for faster results
4. **Independent Context**: Each agent maintains its own conversation history
5. **Transparent**: All responses clearly labeled with agent identifier
