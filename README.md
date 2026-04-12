# reese

A personal AI agent that runs locally. Chat in the terminal or connect via Telegram. No cloud, no database — everything lives in plain markdown files.

```
reese              # open the TUI
reese gateway      # start the Telegram gateway
reese supervisor   # start the supervisor (manages gateway via Telegram)
```

---

## Installation

**Requirements:** [Bun](https://bun.sh) ≥ 1.0

```bash
# clone
git clone <your-repo-url> reese
cd reese

# install dependencies
bun install
```

**Install the `reese` command globally** (optional but recommended):

```bash
bun link
```

Or add a shell alias to your `~/.zshrc` / `~/.bashrc`:

```bash
alias reese='bun run --cwd /path/to/reese src/index.ts'
```

---

## Configuration

Copy the example env file and fill in your settings:

```bash
cp .env.example .env
```

Open `.env`:

```env
# Required — any OpenAI-compatible endpoint
MODEL_API_KEY=sk-...
MODEL_API_BASE=https://api.openai.com/v1
MODEL_NAME=gpt-4o

# Optional — only needed for: reese gateway
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOW_FROM=your_username,123456789

# Workspace directory (stores memory, sessions, skills)
WORKSPACE_DIR=./workspace
```

**Compatible providers:** OpenAI, Anthropic (via OpenAI proxy), Ollama, LM Studio, OpenRouter, Groq, any OpenAI-compatible endpoint.

---

## Run

### TUI — interactive terminal

```bash
reese
```

Opens a full-screen chat interface in your terminal. Type messages, use `/` commands, stream responses live.

### Gateway — Telegram bot

```bash
reese gateway
```

Starts a long-polling Telegram bot. Create a bot via [@BotFather](https://t.me/BotFather), set `TELEGRAM_BOT_TOKEN` in `.env`, and optionally restrict access with `TELEGRAM_ALLOW_FROM`.

**Logging:** When running in gateway mode, all major agent events (messages received, LLM calls, tool executions, errors) are logged to `workspace/agent.log` and sent to Telegram. Configure `TELEGRAM_LOG_CHAT_ID` to specify which chat receives logs, or it defaults to the first user in `TELEGRAM_ALLOW_FROM`.

**Note:** In standalone gateway mode, the `/gateway` restart command is not available. Use supervisor mode for gateway restart capability.

### Supervisor — Gateway lifecycle management

```bash
reese supervisor
```

Starts a supervisor that manages the gateway as a child process. The supervisor enables the `/gateway` command in Telegram to restart the gateway without stopping the bot.

**How it works:**
1. Supervisor spawns gateway as a child process
2. When you send `/gateway` in Telegram, the gateway writes a restart flag file
3. Supervisor detects the flag and restarts the gateway process
4. Connection drops for ~1-2 seconds during restart
5. Gateway comes back online automatically

**Additional supervisor features:**
- Auto-restarts gateway if it crashes
- Sends crash notifications to Telegram
- Provides `/status`, `/stop`, `/start` commands (via supervisor, not gateway)

**Production deployment (Ubuntu/systemd):**

```bash
./install-supervisor.sh
```

This installs the supervisor as a systemd service that starts on boot. View logs with:

```bash
journalctl -u reese-supervisor -f
```

---

## Commands

These work in both TUI and Telegram:

| Command | Description |
|---|---|
| `/new` | Start a new conversation (clears session history) |
| `/end` | Stop the current task |
| `/dream` | Run memory consolidation now |
| `/status` | Show current session info |
| `/gemini <prompt>` | Query Gemini directly (Telegram only) |
| `/double <message>` | Parallel dual-agent with cross-review (Telegram only) |
| `/help` | Show available commands |

### Gemini Integration

Reese includes optional Gemini API integration for direct queries via Telegram. To enable:

1. Create `workspace/.gemini-oauth.json` with your OAuth token:
   ```json
   {
     "access_token": "your-oauth-access-token",
     "expires_at": 1712865120000
   }
   ```

2. Optionally configure model in `.env`:
   ```env
   GEMINI_MODEL=gemini-2.0-flash-exp
   ```

3. Start the gateway:
   ```bash
   reese gateway
   ```

4. Use `/gemini` in Telegram:
   ```
   /gemini What is the capital of France?
   ```

The Gemini integration uses OAuth authentication from your external Gemini login. The token is read from the workspace config file and cached automatically. See [src/gemini/README.md](./src/gemini/README.md) for details.

### Double Agent Mode

The `/double` command runs two AI agents in parallel (default model and think model) and performs cross-review:

1. Both agents process your message independently
2. Each agent's response is sent to Telegram with a label (🤖 Main Agent, 🧠 Think Agent)
3. Each agent reviews the other's response
4. Both reviews are sent to Telegram

This provides diverse perspectives and quality control through peer review. Each agent maintains its own session file:
- Main session: `workspace/sessions/telegram_{chatId}.json`
- Secondary session: `workspace/sessions/telegram_{chatId}_secondary.json`

Configure the think model in `.env`:
```env
THINK_MODEL_API_KEY=sk-...
THINK_MODEL_API_BASE=https://api.openai.com/v1
THINK_MODEL_NAME=o1-preview
```

If not configured, both agents use the default model.

---

## Memory

All memory is stored as human-readable files in `workspace/`:

```
workspace/
  USER.md            # What Reese knows about you
  memory/
    MEMORY.md        # Long-term memory
    history.jsonl    # Conversation archive
  sessions/          # Per-conversation state (JSON)
  skills/            # Your custom skills (SKILL.md files)
  HEARTBEAT.md       # Scheduled tasks (optional)
```

Edit any of these files directly. Changes take effect on the next message.

### Dream

`/dream` triggers a two-phase LLM process that reads `history.jsonl` and surgically updates `MEMORY.md` and `USER.md`. This happens automatically in the background every 2 hours (configurable).

---

## Skills

Skills are markdown instruction files that teach Reese how to perform specific tasks.

**Built-in:** `github`, `weather`, `summarize`, `plan`, `systematic-debugging`

**Add your own:**

```bash
mkdir -p workspace/skills/my-skill
cat > workspace/skills/my-skill/SKILL.md << 'EOF'
---
name: my-skill
description: What this skill does
---

# My Skill

Instructions for Reese...
EOF
```

Reese will automatically discover the skill and include it in its context.

---

## Tools available to the agent

| Tool | Description |
|---|---|
| `read_file` | Read a file with line pagination |
| `write_file` | Write or overwrite a file |
| `edit_file` | Replace text in a file (fuzzy match) |
| `list_dir` | List directory contents |
| `exec` | Run a shell command |
| `grep` | Regex search in files |
| `glob` | Find files by pattern |
| `web_fetch` | Fetch a URL as plain text |
| `web_search` | Search via DuckDuckGo |
| `message` | Send a mid-turn progress message |
| `spawn` | Fire a background subagent task |

---

## Project structure

```
src/
  index.ts          entry point
  cli.tsx           Ink/React terminal UI
  agent/            loop, runner, context, memory, skills, hooks
  bus/              async message queue
  channels/         telegram
  config/           .env schema + workspace paths
  heartbeat/        scheduled task runner
  providers/        OpenAI-compatible LLM client
  session/          conversation persistence
  tools/            all agent tools
skills/             built-in skills
workspace/          your data (gitignored)
```
