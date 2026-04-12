#!/usr/bin/env bun
/**
 * Test script to verify Discord and channel manager setup
 */

import { loadConfig } from "./config/schema.js";

try {
  const config = loadConfig();
  
  console.log("✓ Configuration loaded successfully");
  console.log("\nChannel configuration:");
  console.log(`  Telegram: ${config.telegramBotToken ? "✓ configured" : "✗ not configured"}`);
  console.log(`  Discord:  ${config.discordBotToken ? "✓ configured" : "✗ not configured"}`);
  
  if (config.telegramBotToken) {
    console.log(`    - Allowed users: ${config.telegramAllowFrom.join(", ") || "all"}`);
  }
  
  if (config.discordBotToken) {
    console.log(`    - Allowed users: ${config.discordAllowFrom.join(", ") || "all"}`);
  }
  
  if (!config.telegramBotToken && !config.discordBotToken) {
    console.log("\n⚠️  No bot tokens configured. Set TELEGRAM_BOT_TOKEN or DISCORD_BOT_TOKEN in .env");
    process.exit(1);
  }
  
  console.log("\n✓ Gateway mode is ready to start");
  console.log("  Run: bun run src/index.ts gateway");
  
} catch (err) {
  console.error("❌ Configuration error:", err instanceof Error ? err.message : err);
  process.exit(1);
}
