#!/usr/bin/env bun
import { spawn, type Subprocess } from "bun";
import { Client, GatewayIntentBits, Partials, Events, type Message } from "discord.js";
import { loadConfig } from "./config/schema.js";
import { writeFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

const config = loadConfig();

if (!config.discordBotToken) {
  console.error("❌ DISCORD_BOT_TOKEN is not set in .env — Supervisor requires Discord.");
  process.exit(1);
}

const PID_FILE = resolve(config.workspaceDir, ".gateway.pid");
const RESTART_FLAG = resolve(config.workspaceDir, ".gateway.restart");

// ─── Discord client ────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

const allowFrom = new Set(config.discordAllowFrom);

function isAllowed(msg: Message): boolean {
  if (!allowFrom.size) return true;
  return (
    allowFrom.has(msg.author.id) ||
    allowFrom.has(msg.author.username) ||
    allowFrom.has("*")
  );
}

async function sendLog(text: string) {
  // Send a status message to the first allowed Discord user/channel via DM,
  // or to a configured log channel if DISCORD_LOG_CHANNEL_ID is set.
  const logChannelId = process.env.DISCORD_LOG_CHANNEL_ID;
  if (!logChannelId) return;
  try {
    const ch = await client.channels.fetch(logChannelId);
    if (ch?.isTextBased() && "send" in ch) {
      await ch.send(text);
    }
  } catch {
    // best-effort
  }
}

// ─── Gateway process management ────────────────────────────────────────────────
let gatewayProcess: Subprocess | null = null;

function startGateway() {
  console.log("Starting gateway...");
  gatewayProcess = spawn(["bun", "run", "src/index.ts", "gateway"], {
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, SUPERVISOR_MODE: "1" } as Record<string, string>,
  });
  console.log(`Gateway started (PID: ${gatewayProcess.pid})`);
  writeFileSync(PID_FILE, String(gatewayProcess.pid), "utf-8");
}

function stopGateway(): Promise<void> {
  return new Promise((resolve) => {
    if (!gatewayProcess) return resolve();
    console.log(`Stopping gateway (PID: ${gatewayProcess.pid})...`);
    gatewayProcess.kill("SIGTERM");
    const forceKill = setTimeout(() => {
      console.warn("Gateway didn't stop gracefully, force killing...");
      gatewayProcess?.kill("SIGKILL");
    }, 10_000);
    gatewayProcess.exited.then(() => {
      clearTimeout(forceKill);
      gatewayProcess = null;
      if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
      console.log("Gateway stopped.");
      resolve();
    });
  });
}

function isGatewayRunning(): boolean {
  return gatewayProcess !== null && gatewayProcess.exitCode === null;
}

// ─── Command handler ───────────────────────────────────────────────────────────
const PREFIX = "!";

client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot) return;
  if (!isAllowed(msg)) return;
  if (!msg.content.startsWith(PREFIX)) return;

  const [cmd] = msg.content.slice(PREFIX.length).trim().split(/\s+/);

  switch (cmd?.toLowerCase()) {
    case "status":
      if (isGatewayRunning()) {
        await msg.reply(`✅ Gateway is **running** (PID: \`${gatewayProcess!.pid}\`)`);
      } else {
        await msg.reply("❌ Gateway is **not running**");
      }
      break;

    case "start":
      if (isGatewayRunning()) {
        await msg.reply("⚠️ Gateway is already running.");
      } else {
        startGateway();
        await msg.reply("▶️ Gateway started.");
      }
      break;

    case "stop":
      if (!isGatewayRunning()) {
        await msg.reply("⚠️ Gateway is already stopped.");
      } else {
        await stopGateway();
        await msg.reply("🛑 Gateway stopped.");
      }
      break;

    case "restart":
    case "gateway":
      await msg.reply("🔄 Restarting gateway...\n_Connection will drop briefly._");
      writeFileSync(RESTART_FLAG, "1", "utf-8");
      break;

    case "help":
      await msg.reply(
        "**Supervisor commands**\n" +
        "`!status` — check gateway status\n" +
        "`!start` — start gateway\n" +
        "`!stop` — stop gateway\n" +
        "`!restart` — restart gateway"
      );
      break;
  }
});

// ─── Restart-flag watcher ──────────────────────────────────────────────────────
async function watchRestartFlag() {
  while (true) {
    if (existsSync(RESTART_FLAG)) {
      console.log("Restart flag detected, restarting gateway...");
      unlinkSync(RESTART_FLAG);
      await sendLog("🔄 Restarting gateway...");
      await stopGateway();
      await Bun.sleep(1000);
      startGateway();
      await Bun.sleep(2000);
      await sendLog("✅ Gateway restarted successfully!");
    }
    await Bun.sleep(500);
  }
}

// ─── Auto-restart watcher ──────────────────────────────────────────────────────
async function watchGateway() {
  while (true) {
    if (gatewayProcess && !isGatewayRunning()) {
      console.warn("Gateway crashed! Auto-restarting in 3s...");
      await sendLog("⚠️ Gateway crashed — auto-restarting...");
      await Bun.sleep(3000);
      startGateway();
      await Bun.sleep(2000);
      await sendLog("✅ Gateway auto-restarted.");
    }
    await Bun.sleep(5000);
  }
}

// ─── Lifecycle ─────────────────────────────────────────────────────────────────
process.once("SIGINT", async () => {
  console.log("\n[Supervisor] Shutting down...");
  await stopGateway();
  await client.destroy();
  process.exit(0);
});

process.once("SIGTERM", async () => {
  await stopGateway();
  await client.destroy();
  process.exit(0);
});

client.once(Events.ClientReady, (c) => {
  console.log(`🔧 Supervisor running (Discord: ${c.user.tag})`);
  startGateway();
  watchGateway();
  watchRestartFlag();
});

client.login(config.discordBotToken);
