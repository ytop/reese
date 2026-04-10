#!/usr/bin/env bash
# Gemini CLI wrapper for Reese Agent

set -e

if ! command -v gemini &> /dev/null; then
    echo "Error: gemini CLI not found in PATH" >&2
    echo "Install: npm install -g @google/generative-ai-cli" >&2
    exit 1
fi

# Pass all arguments to gemini CLI
gemini -p "$@"
