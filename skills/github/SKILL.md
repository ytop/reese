---
name: github
description: Interact with GitHub using the gh CLI — create PRs, view issues, manage repos.
version: 1.0.0
metadata: '{"reese":{"requires":{"bins":["gh"]},"tags":["github","git","vcs"]}}'
---

# GitHub Skill

Use this skill when the user wants to interact with GitHub (PRs, issues, repos, gists, etc.).

## Prerequisites

Requires the `gh` GitHub CLI to be installed and authenticated.
Check auth status: `exec("gh auth status")`

## Common Operations

### View open issues
```
exec("gh issue list")
```

### Create a PR
```
exec("gh pr create --title 'Title' --body 'Description'")
```

### View PR status
```
exec("gh pr status")
```

### Clone a repo
```
exec("gh repo clone owner/repo")
```

### View a file from another repo
```
exec("gh api repos/owner/repo/contents/path/to/file --jq .content | base64 -d")
```

## Tips
- Always check `gh auth status` first if operations fail
- Use `--help` on any gh subcommand for options
- Use `gh api` for raw GitHub API access
