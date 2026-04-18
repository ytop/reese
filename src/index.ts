#!/usr/bin/env bun
/**
 * Reese — Personal AI Agent
 *
 * Usage:
 *   reese              → Interactive TUI
 *   reese gateway      → Start gateway (Telegram bot — only)
 *   reese supervisor   → Start supervisor (Discord bot — only)
 */

import { loadConfig } from "./config/schema.js";
import { MessageBus } from "./bus/queue.js";
import { OpenAICompatProvider } from "./providers/openai_compat.js";
import { AgentLoop } from "./agent/loop.js";
import { TelegramChannel } from "./channels/telegram.js";
import { HeartbeatService } from "./heartbeat/service.js";
import { ensureWorkspace } from "./config/paths.js";
import { writeFileSync, existsSync } from "node:fs";
import { Logger } from "./logger.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
reese — Personal AI Agent

Usage:
  reese              Launch the interactive TUI
  reese gateway      Start the gateway (Telegram bot + Discord fallback)
  reese supervisor   Start the supervisor (manages gateway via Discord)

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
    await import("./supervisor.js");
    return;
  }

  if (mode === "gateway") {
    // Gateway mode — support for Telegram and/or Discord
    if (!config.telegramBotToken && !config.discordBotToken) {
      console.error("❌ Neither TELEGRAM_BOT_TOKEN nor DISCORD_BOT_TOKEN is set. Gateway requires at least one channel.");
      process.exit(1);
    }

    const channels: any[] = [];

    if (config.telegramBotToken) {
      const { TelegramChannel } = await import("./channels/telegram.js");
      const telegram = new TelegramChannel(
        config.telegramBotToken,
        bus,
        config.telegramAllowFrom,
        provider,
      );
      channels.push({
        name: "telegram",
        channel: telegram,
        rateLimitWindow: 60000, // 1 minute
        rateLimitMax: 20, // 20 messages per minute
      });
    }

    if (config.discordBotToken && !process.env.SUPERVISOR_MODE) {
      const { DiscordChannel } = await import("./channels/discord.js");
      const discord = new DiscordChannel(
        config.discordBotToken,
        bus,
        config.discordAllowFrom,
      );
      channels.push({
        name: "discord",
        channel: discord,
        rateLimitWindow: 60000,
        rateLimitMax: 50,
      });
    }

    const { ChannelManager } = await import("./channels/manager.js");
    const manager = new ChannelManager(bus, channels);
    
    console.log(`🤖 reese gateway starting (model: ${config.modelName})`);
    console.log(`   Channels: ${channels.map(c => c.name).join(", ")}`);

    // Configure logger to send to Telegram if available
    if (config.telegramBotToken) {
      const logChatId = config.telegramLogChatId || config.telegramAllowFrom[0];
      if (logChatId) {
        logger.setTelegram(bus, logChatId);
        logger.info("System", `Agent started in gateway mode (model: ${config.modelName})`);
      }
    } else {
      console.warn("⚠️  No TELEGRAM_LOG_CHAT_ID configured - logs will only be written to file");
    }

    // Run agent loop in background
    loop.run().catch(console.error);

    // Shutdown on SIGINT/SIGTERM
    process.once("SIGINT", async () => {
      console.log("\n[Shutdown] Stopping...");
      loop.stop();
      heartbeat.stop();
      await manager.stop();
      process.exit(0);
    });
    process.once("SIGTERM", async () => {
      loop.stop();
      heartbeat.stop();
      await manager.stop();
      process.exit(0);
    });

    await manager.start();
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
