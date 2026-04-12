# Migration: AGENTS.md and SOUL.md Removed

## Summary

The content from `AGENTS.md` and `SOUL.md` has been merged into the `buildIdentity()` function in `src/agent/context.ts`. Both files have been permanently removed from the workspace.

## Changes Made

### 1. Merged Content into Code
**File:** `src/agent/context.ts`
- Updated `buildIdentity()` method to include agent instructions inline
- Added Core Principles section from AGENTS.md
- Changed description from "AI agent running locally" to "AI assistant"

### 2. Removed File References
**File:** `src/agent/context.ts`
- Removed `AGENTS.md` and `SOUL.md` from `BOOTSTRAP_FILES` array
- Now only loads `USER.md` as bootstrap file

**File:** `src/config/paths.ts`
- Removed `soulFile` and `agentsFile` from workspace paths
- Cleaned up path definitions

**File:** `src/agent/memory.ts`
- Removed `readSoul()` and `writeSoul()` methods from `MemoryStore`
- Removed SOUL.md from Dream consolidation context
- Removed soul updates from Dream phase 2
- Updated JSON schema to only include `memory` and `user` keys

**File:** `src/index.ts`
- Removed bootstrap creation of AGENTS.md and SOUL.md
- Only creates MEMORY.md if missing

**File:** `README.md`
- Removed AGENTS.md and SOUL.md from workspace structure diagram
- Updated `/dream` description to only mention MEMORY.md and USER.md

### 3. Deleted Files
- `/Users/danaoshu/boc/reese/workspace/AGENTS.md` ✓ Deleted
- `/Users/danaoshu/boc/reese/workspace/SOUL.md` ✓ Deleted

## Benefits

1. **Simpler Architecture**: Agent identity is now defined in code, not external files
2. **Fewer Files**: Reduced workspace clutter
3. **Version Control**: Agent behavior changes are tracked in git
4. **No Bootstrap Needed**: No need to create/maintain these files
5. **Cleaner Memory System**: Dream only manages MEMORY.md and USER.md

## Agent Identity Now Defined As

```typescript
You are Reese, a personal AI assistant.
Current time: [timestamp]
Channel: [channel]
Workspace: [path]

## Core Principles
- Be helpful, honest, and direct
- Use tools proactively to get things done
- Store important facts in memory files
- Load skill files when you need specialized guidance
- Keep responses concise unless detail is needed

[Tool and memory system description...]
```

## Verification

All references to `soulFile`, `agentsFile`, `readSoul()`, and `writeSoul()` have been removed from the codebase. The code compiles successfully.
