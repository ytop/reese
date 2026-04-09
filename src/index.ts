#!/usr/bin/env bun
/**
 * Reese — Personal AI Agent
 *
 * Usage:
 *   reese              → Interactive TUI
 *   reese gateway      → Start gateway (Telegram bot)
 */

import { loadConfig } from "./config/schema.js";
import { MessageBus } from "./bus/queue.js";
import { OpenAICompatProvider } from "./providers/openai_compat.js";
import { AgentLoop } from "./agent/loop.js";
import { TelegramChannel } from "./channels/telegram.js";
import { HeartbeatService } from "./heartbeat/service.js";
import { ensureWorkspace } from "./config/paths.js";
import { writeFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
reese — Personal AI Agent

Usage:
  reese              Launch the interactive TUI
  reese gateway      Start the gateway (Telegram bot)

Environment:
  Copy .env.example to .env and fill in your settings.
  `);
  process.exit(0);
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error("❌ Configuration error:", err instanceof Error ? err.message : err);
    console.error("   Copy .env.example to .env and fill in your settings.");
    process.exit(1);
  }

  // Ensure workspace exists and create default files
  const paths = ensureWorkspace(config.workspaceDir);
  bootstrapWorkspace(paths);

  // Core wiring
  const bus = new MessageBus();
  const provider = new OpenAICompatProvider({
    apiKey: config.modelApiKey,
    apiBase: config.modelApiBase,
    defaultModel: config.modelName,
    maxTokens: config.maxTokens,
  });
  const loop = new AgentLoop(bus, provider, config);

  // Heartbeat
  const heartbeat = new HeartbeatService(loop, config);
  heartbeat.start();

  const mode = args[0];

  if (mode === "gateway") {
    // Gateway mode (Telegram)
    if (!config.telegramBotToken) {
      console.error("❌ TELEGRAM_BOT_TOKEN is not set in .env");
      process.exit(1);
    }
    const telegram = new TelegramChannel(
      config.telegramBotToken,
      bus,
      config.telegramAllowFrom
    );
    console.log(`🤖 reese gateway starting (model: ${config.modelName})`);

    // Run agent loop in background
    loop.run().catch(console.error);

    // Shutdown on SIGINT/SIGTERM
    process.once("SIGINT", async () => {
      console.log("\n[Shutdown] Stopping...");
      loop.stop();
      heartbeat.stop();
      await telegram.stop();
      process.exit(0);
    });
    process.once("SIGTERM", async () => {
      loop.stop();
      heartbeat.stop();
      await telegram.stop();
      process.exit(0);
    });

    await telegram.start();
  } else {
    // TUI mode (default)
    console.log(`🤖 reese starting (model: ${config.modelName})`);
    console.log(`   Workspace: ${config.workspaceDir}`);

    const { startCli } = await import("./cli.js");
    startCli(loop, bus);

    process.once("SIGINT", () => {
      loop.stop();
      heartbeat.stop();
      process.exit(0);
    });
  }
}

function bootstrapWorkspace(paths: ReturnType<typeof ensureWorkspace>) {
  if (!existsSync(paths.soulFile)) {
    writeFileSync(
      paths.soulFile,
      `# Soul\n\nYou are Reese, a personal AI agent. You are helpful, direct, and thoughtful.\n` +
      `You remember context across conversations and learn from your interactions.\n`,
      "utf-8"
    );
  }
  if (!existsSync(paths.agentsFile)) {
    writeFileSync(
      paths.agentsFile,
      `# Reese Agent Instructions\n\n` +
      `You are Reese, a personal AI assistant.\n\n` +
      `## Core Principles\n` +
      `- Be helpful, honest, and direct\n` +
      `- Use tools proactively to get things done\n` +
      `- Store important facts in memory files\n` +
      `- Load skill files when you need specialized guidance\n` +
      `- Keep responses concise unless detail is needed\n`,
      "utf-8"
    );
  }
  if (!existsSync(paths.memoryFile)) {
    writeFileSync(paths.memoryFile, `# Memory\n\n(No memories yet)\n`, "utf-8");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
