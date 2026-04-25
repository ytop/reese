---
name: calendar
description: Manage calendar events
---

# Calendar Management

Use the calendar app located in `./app/` to manage events.

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

**List events in range:**
```bash
bun app/cli.tsx list "<start_date>" "<end_date>"
```
Example: `bun app/cli.tsx list "2026-04-01" "2026-04-30"`

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

Use ISO format (YYYY-MM-DD).

## Examples

- "Add a meeting on April 15th" → `bun app/cli.tsx add "Meeting" "2026-04-15"`
- "Show events for this week" → `bun app/cli.tsx list "2026-04-20" "2026-04-26"`
- "Update event 5 title" → `bun app/cli.tsx update 5 title "New Title"`
- "Delete event 5" → `bun app/cli.tsx delete 5`
