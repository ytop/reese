#!/usr/bin/env node
/**
 * TypeScript wrapper for Gemini CLI
 * Usage: bun run scripts/gemini.ts "your prompt here"
 */

import { execSync } from 'child_process';

const prompt = process.argv.slice(2).join(' ');

if (!prompt) {
  console.error('Usage: gemini.ts <prompt>');
  process.exit(1);
}

try {
  const result = execSync(`gemini -p "${prompt.replace(/"/g, '\\"')}"`, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe']
  });
  console.log(result);
} catch (error: any) {
  console.error('Error:', error.message);
  process.exit(1);
}
