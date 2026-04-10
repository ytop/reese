---
name: gemini
description: Invoke Gemini CLI to process tasks and messages using Google's Gemini AI models
version: 1.0.0
author: Reese
license: MIT
metadata:
  reese:
    tags: [Gemini, AI, CLI, Google]
---

# Gemini CLI Integration

Invoke the Gemini CLI to process tasks and messages using Google's Gemini AI models.

## Prerequisites

- Gemini CLI must be installed and available in PATH
- Install: `npm install -g @google/generative-ai-cli` or similar

## Usage

### Telegram Slash Command

Use `/gemini` in Telegram to ask Gemini AI directly:

```
/gemini What is the weather today?
/gemini Explain quantum computing
/gemini Write a haiku about coding
```

The bot will invoke the Gemini CLI and reply with the response in the channel.

### Command Line

```bash
# Interactive mode
gemini "your prompt here"

# Non-interactive (headless) mode
gemini -p "your prompt here"

# With specific model
gemini -m gemini-pro "your prompt"

# YOLO mode (auto-approve all actions)
gemini -y "your prompt"
```

## Scripts

### Bash Wrapper
Use `scripts/gemini.sh` to invoke Gemini CLI:

```bash
./skills/gemini/scripts/gemini.sh "What is the weather today?"
```

### TypeScript Wrapper
Use `scripts/gemini.ts` for programmatic access:

```bash
bun run ./skills/gemini/scripts/gemini.ts "Explain quantum computing"
```

## Examples

```bash
# Ask a question
gemini -p "Explain quantum computing in simple terms"

# Code generation
gemini -p "Write a TypeScript function to sort an array"

# File analysis
cat file.txt | gemini -p "Summarize this content"
```

## Options

- `-p, --prompt`: Non-interactive mode with prompt
- `-m, --model`: Specify model (e.g., gemini-pro)
- `-y, --yolo`: Auto-approve all actions
- `-i, --prompt-interactive`: Execute prompt then continue interactively
- `-s, --sandbox`: Run in sandbox mode

## Notes

- The skill wraps the Gemini CLI for easy integration with Reese
- Supports both interactive and non-interactive modes
- Can pipe input via stdin
