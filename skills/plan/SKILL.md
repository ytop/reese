---
name: plan
description: Plan mode — think through a task and write a structured plan to the workspace instead of executing immediately.
version: 1.0.0
metadata: '{"reese":{"tags":["planning","workflow"]}}'
---

# Plan Mode

Use this skill when the user asks you to plan rather than execute.

## Core Behavior

For this turn, you are planning only.

- Do **not** implement code or make changes
- Do **not** run mutating commands
- You **may** read files and explore the codebase
- Your deliverable is a markdown plan file

## Plan Format

Write a structured plan covering:
- **Goal**: What are we trying to achieve?
- **Context**: Current state, relevant files, assumptions
- **Approach**: High-level strategy
- **Steps**: Numbered, concrete action items
- **Files to change**: Specific paths
- **Tests/Validation**: How to verify success
- **Risks**: What could go wrong

## Save Location

Save the plan at: `workspace/plans/YYYY-MM-DD_slug.md`

Use `write_file` to save it.

## Interaction

- If the request is clear, write the plan directly
- If underspecified, ask one clarifying question
- After saving, briefly confirm what was planned and the file path
