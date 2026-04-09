---
name: summarize
description: Summarize URLs, text files, and documents.
version: 1.0.0
metadata: '{"reese":{"tags":["summarize","reading","productivity"]}}'
---

# Summarize Skill

Use this skill to summarize content from URLs, files, or text.

## Summarize a URL

1. Fetch the content: `web_fetch("https://example.com/article")`
2. Summarize the returned text in your response

## Summarize a file

1. Read it: `read_file("path/to/document.md")`
2. Provide a structured summary

## Summary format (recommended)

For articles/docs:
- **What**: One sentence description
- **Key Points**: 3-5 bullet points
- **Conclusion**: Main takeaway

For code files:
- **Purpose**: What the code does
- **Key Functions/Classes**: Brief list
- **Notable Patterns**: Any interesting design choices

## Tips
- For long URLs, check if there's an `/api` or `/raw` version
- For YouTube, check if a transcript is available at the URL
- Keep summaries proportional to the original — short article = short summary
