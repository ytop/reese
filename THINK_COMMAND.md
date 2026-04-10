# /think Command Implementation

## Overview
Added a `/think` command that allows using a separate model (with its own API credentials) for difficult tasks. The think model can be from a different provider than the default model.

## Changes Made

### 1. Environment Configuration (.env.example)
- Added `THINK_MODEL_NAME=` (optional)
- Added `THINK_MODEL_API_KEY=` (optional)
- Added `THINK_MODEL_API_BASE=` (optional)

### 2. Config Schema (src/config/schema.ts)
- Added `THINK_MODEL_NAME`, `THINK_MODEL_API_KEY`, `THINK_MODEL_API_BASE` to ConfigSchema
- Added corresponding fields to AppConfig interface
- Mapped environment variables to config object

### 3. Agent Runner (src/agent/runner.ts)
- Added optional `provider` field to RunSpec interface
- Modified `run()` method to use spec.provider if provided, otherwise use default provider

### 4. Agent Loop (src/agent/loop.ts)
- Added `thinkProvider` field to store separate LLM provider for think model
- Constructor initializes `thinkProvider` if `THINK_MODEL_NAME` and `THINK_MODEL_API_KEY` are configured
- Added `/think` command handler that validates input
- Updated `/help` to document `/think` command
- Modified `processMessage` to:
  - Detect `/think` prefix
  - Select appropriate model and provider
  - Pass provider to runner
  - Strip `/think` prefix before processing
  - Log which model is being used

## Usage

### Configuration
```bash
# In .env file
# Default model
MODEL_API_KEY=sk-openai-key
MODEL_API_BASE=https://api.openai.com/v1
MODEL_NAME=gpt-4o

# Think model (can be different provider)
THINK_MODEL_NAME=claude-3-5-sonnet-20241022
THINK_MODEL_API_KEY=sk-ant-key
THINK_MODEL_API_BASE=https://api.anthropic.com/v1
```

### In Chat
```
# Use default model
What is 2+2?

# Use think model with separate provider
/think Explain quantum entanglement in detail
```

## Behavior
- If `THINK_MODEL_NAME` is not configured, `/think` uses the default `MODEL_NAME`
- If `THINK_MODEL_API_KEY` is not set, uses default provider credentials
- If `THINK_MODEL_API_BASE` is not set, falls back to default `MODEL_API_BASE`
- The `/think` prefix is stripped before processing
- Works in both TUI and Telegram gateway modes
- Session history stores actual content without `/think` prefix
