---
name: systematic-debugging
description: Systematic approach to debugging — reproduce, isolate, hypothesize, verify.
version: 1.0.0
metadata: '{"reese":{"tags":["debugging","development"]}}'
---

# Systematic Debugging

Use this skill when tackling bugs or unexpected behavior.

## The Debugging Cycle

### 1. Reproduce
- Get exact steps to reproduce the bug
- Identify the minimal case that triggers it
- Note: environment, inputs, expected vs actual behavior

### 2. Gather Evidence
- Check error messages and stack traces: `exec("...")`
- Read relevant log files: `read_file("...")`
- Understand the code path: `grep("...")`, `read_file("...")`

### 3. Form Hypotheses
- List 2-3 plausible causes
- Order by likelihood
- Consider recent changes

### 4. Test Hypotheses
- Start with the most likely cause
- Make one change at a time
- Verify before moving to the next hypothesis

### 5. Fix & Verify
- Apply the minimal fix
- Verify the bug is gone
- Check for regressions
- Write a test if possible

## Common Tools

```
# Check running processes
exec("ps aux | grep <name>")

# Check logs
exec("tail -n 50 /var/log/...")

# Check environment
exec("env | grep <VAR>")

# Check file permissions
exec("ls -la <path>")
```

## Tips
- Don't change multiple things at once
- If confused, add logging/print statements
- Check the obvious things first (typos, missing env vars, wrong paths)
- Read the error message carefully — it usually tells you what's wrong
