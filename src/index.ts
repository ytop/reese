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
import { GeminiHandler, GeminiOAuthProvider } from "./gemini/index.js";
import { ensureWorkspace } from "./config/paths.js";
import { writeFileSync, existsSync } from "node:fs";
import { Logger } from "./logger.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
reese — Personal AI Agent

Usage:
  reese              Launch the interactive TUI
  reese gateway      Start the gateway (Telegram bot)
  reese supervisor   Start the supervisor (manages gateway via Telegram)

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

  // Initialize logger
  const logger = Logger.init(config.workspaceDir);

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

  if (mode === "supervisor") {
    // Supervisor mode - manages gateway lifecycle
    const { default: supervisor } = await import("./supervisor.js");
    return;
  }

  if (mode === "gateway") {
    // Gateway mode (Telegram)
    if (!config.telegramBotToken) {
      console.error("❌ TELEGRAM_BOT_TOKEN is not set in .env");
      process.exit(1);
    }
    const telegram = new TelegramChannel(
      config.telegramBotToken,
      bus,
      config.telegramAllowFrom,
      provider,
    );
    
    // Initialize Gemini handler with OAuth
    let geminiHandler: GeminiHandler | null = null;
    try {
      const oauthProvider = new GeminiOAuthProvider(config.workspaceDir);
      geminiHandler = new GeminiHandler({
        getAccessToken: () => oauthProvider.getAccessToken(),
        model: process.env.GEMINI_MODEL,
        apiBase: process.env.GEMINI_API_BASE,
      }, bus);
      console.log(`🔮 Gemini integration enabled (OAuth)`);
    } catch (err) {
      console.log(`ℹ️  Gemini integration disabled: ${err instanceof Error ? err.message : err}`);
    }
    
    console.log(`🤖 reese gateway starting (model: ${config.modelName})`);

    // Configure logger to send to Telegram
    const logChatId = config.telegramLogChatId || config.telegramAllowFrom[0];
    if (logChatId) {
      logger.setTelegram(bus, logChatId);
      logger.info("System", `Agent started in gateway mode (model: ${config.modelName})`);
    } else {
      console.warn("⚠️  No TELEGRAM_LOG_CHAT_ID or TELEGRAM_ALLOW_FROM configured - logs will only be written to file");
    }

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
  if (!existsSync(paths.memoryFile)) {
    writeFileSync(paths.memoryFile, `# Memory\n\n(No memories yet)\n`, "utf-8");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
