---
name: calendar
description: Manage calendar events using the local calendar app
---

# Calendar Management

Use the calendar app located in `./app/` to manage events.

## Available Commands

**Add event:**
```bash
cd app && bun cli.tsx add "<title>" "<date>" "[description]"
```

**List all events:**
```bash
cd app && bun cli.tsx list
```

**Get event details:**
```bash
cd app && bun cli.tsx get <id>
```

**Update event:**
```bash
cd app && bun cli.tsx update <id> <field> "<value>"
```
Fields: `title`, `date`, `description`

**Delete event:**
```bash
cd app && bun cli.tsx delete <id>
```

## Date Format

Use ISO format (YYYY-MM-DD) or natural dates like "2026-04-15".

## Examples

- "Add a meeting on April 15th" → `cd app && bun cli.tsx add "Meeting" "2026-04-15"`
- "Show my calendar" → `cd app && bun cli.tsx list`
- "Delete event 1234567890" → `cd app && bun cli.tsx delete 1234567890`
