import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { MessageBus } from "./bus/queue.js";

export type LogLevel = "info" | "debug" | "warn" | "error";

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  category: string;
  message: string;
}

export class Logger {
  private static instance: Logger | null = null;
  private logPath: string;
  private bus: MessageBus | null = null;
  private telegramChatId: string | null = null;

  private constructor(workspaceDir: string) {
    this.logPath = join(workspaceDir, "agent.log");
  }

  static init(workspaceDir: string): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger(workspaceDir);
    }
    return Logger.instance;
  }

  static get(): Logger {
    if (!Logger.instance) {
      throw new Error("Logger not initialized");
    }
    return Logger.instance;
  }

  setTelegram(bus: MessageBus, chatId: string): void {
    this.bus = bus;
    this.telegramChatId = chatId;
  }

  private format(entry: LogEntry): string {
    return `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.category}] ${entry.message}`;
  }

  private write(level: LogLevel, category: string, message: string): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      category,
      message,
    };

    const line = this.format(entry);
    
    // Write to file
    try {
      appendFileSync(this.logPath, line + "\n");
    } catch (err) {
      console.error("[Logger] Failed to write to log file:", err);
    }

    // Send to Telegram if configured (only info, warn, error)
    if (this.bus && this.telegramChatId && level !== "debug") {
      try {
        const emoji = level === "error" ? "🔴" : level === "warn" ? "⚠️" : "ℹ️";
        this.bus.publishOutbound({
          channel: "telegram",
          chatId: this.telegramChatId,
          content: `${emoji} [${category}] ${message}`,
          metadata: { _log: true },
        });
      } catch (err) {
        console.error("[Logger] Failed to send to Telegram:", err);
      }
    }
  }

  info(category: string, message: string): void {
    this.write("info", category, message);
  }

  debug(category: string, message: string): void {
    this.write("debug", category, message);
  }

  warn(category: string, message: string): void {
    this.write("warn", category, message);
  }

  error(category: string, message: string): void {
    this.write("error", category, message);
  }
}
