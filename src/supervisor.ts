#!/usr/bin/env bun
import { spawn, type Subprocess } from "bun";
import { Bot } from "grammy";
import { loadConfig } from "./config/schema.js";
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

const config = loadConfig();

if (!config.telegramBotToken) {
  console.error("❌ TELEGRAM_BOT_TOKEN is not set in .env");
  process.exit(1);
}

const PID_FILE = resolve(config.workspaceDir, ".gateway.pid");
const RESTART_FLAG = resolve(config.workspaceDir, ".gateway.restart");

const bot = new Bot(config.telegramBotToken);
const allowFrom = new Set(config.telegramAllowFrom);
let gatewayProcess: Subprocess | null = null;

function isAllowed(chatId: number, username?: string): boolean {
  if (!allowFrom.size) return true;
  const uid = String(chatId);
  return allowFrom.has(uid) || allowFrom.has(username ?? "") || allowFrom.has("*");
}

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

// Watch for restart flag from gateway
async function watchRestartFlag() {
  while (true) {
    if (existsSync(RESTART_FLAG)) {
      console.log("Restart flag detected, restarting gateway...");
      unlinkSync(RESTART_FLAG);
      const logChatId = config.telegramLogChatId || config.telegramAllowFrom[0];
      if (logChatId) {
        await bot.api.sendMessage(parseInt(logChatId), "🔄 Restarting gateway...");
      }
      await stopGateway();
      await Bun.sleep(1000);
      startGateway();
      await Bun.sleep(2000);
      if (logChatId) {
        await bot.api.sendMessage(parseInt(logChatId), "✅ Gateway restarted successfully!");
      }
    }
    await Bun.sleep(500);
  }
}

bot.command("gateway", async (ctx) => {
  if (!isAllowed(ctx.chat.id, ctx.from?.username)) return;
  await ctx.reply("🔄 Restarting gateway...\n_Connection will drop briefly._", { parse_mode: "Markdown" });
  writeFileSync(RESTART_FLAG, "1", "utf-8");
});

bot.command("status", async (ctx) => {
  if (!isAllowed(ctx.chat.id, ctx.from?.username)) return;
  if (isGatewayRunning()) {
    await ctx.reply(`✅ Gateway is *running* (PID: \`${gatewayProcess!.pid}\`)`, { parse_mode: "Markdown" });
  } else {
    await ctx.reply("❌ Gateway is *not running*", { parse_mode: "Markdown" });
  }
});

bot.command("stop", async (ctx) => {
  if (!isAllowed(ctx.chat.id, ctx.from?.username)) return;
  if (!isGatewayRunning()) return ctx.reply("⚠️ Gateway is already stopped.");
  await stopGateway();
  await ctx.reply("🛑 Gateway stopped.");
});

bot.command("start", async (ctx) => {
  if (!isAllowed(ctx.chat.id, ctx.from?.username)) return;
  if (isGatewayRunning()) return ctx.reply("⚠️ Gateway is already running.");
  startGateway();
  await ctx.reply("▶️ Gateway started.");
});

async function watchGateway() {
  while (true) {
    if (gatewayProcess && !isGatewayRunning()) {
      console.warn("Gateway crashed! Auto-restarting in 3s...");
      const logChatId = config.telegramLogChatId || config.telegramAllowFrom[0];
      if (logChatId) {
        await bot.api.sendMessage(parseInt(logChatId), "⚠️ Gateway crashed — auto-restarting...");
      }
      await Bun.sleep(3000);
      startGateway();
      await Bun.sleep(2000);
      if (logChatId) {
        await bot.api.sendMessage(parseInt(logChatId), "✅ Gateway auto-restarted.");
      }
    }
    await Bun.sleep(5000);
  }
}

process.once("SIGINT", async () => {
  console.log("\n[Supervisor] Shutting down...");
  await stopGateway();
  await bot.stop();
  process.exit(0);
});

process.once("SIGTERM", async () => {
  await stopGateway();
  await bot.stop();
  process.exit(0);
});

startGateway();
watchGateway();
watchRestartFlag();
bot.start();
console.log("🔧 Supervisor running.");
