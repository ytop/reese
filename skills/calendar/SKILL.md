---
name: calendar
description: Manage calendar events using the local calendar app
---

# Calendar Management

Use the calendar app located in `./app/` to manage events.

> **Data file:** `$HOME/.reese/workspace/calendar/events.json`

## Available Commands

All commands must be run from the **repo root** using `bun app/cli.tsx ...`.

**Add event:**
```bash
bun app/cli.tsx add "<title>" "<date>" "[description]"
```

**List all events:**
```bash
bun app/cli.tsx list
```

**Get event details:**
```bash
bun app/cli.tsx get <id>
```

**Update event:**
```bash
bun app/cli.tsx update <id> <field> "<value>"
```
Fields: `title`, `date`, `description`

**Delete event:**
```bash
bun app/cli.tsx delete <id>
```

## Date Format

Use ISO format (YYYY-MM-DD) or natural dates like "2026-04-15".

## Examples

- "Add a meeting on April 15th" → `bun app/cli.tsx add "Meeting" "2026-04-15"`
- "Show my calendar" → `bun app/cli.tsx list`
- "Delete event 1234567890" → `bun app/cli.tsx delete 1234567890`
