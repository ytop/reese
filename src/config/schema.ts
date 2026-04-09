import { config as dotenvConfig } from "dotenv";
import { z } from "zod";
import { resolve } from "node:path";

dotenvConfig();

const ConfigSchema = z.object({
  MODEL_API_KEY: z.string().min(1, "MODEL_API_KEY is required"),
  MODEL_API_BASE: z.string().url("MODEL_API_BASE must be a valid URL").default("https://api.openai.com/v1"),
  MODEL_NAME: z.string().default("gpt-4o"),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_ALLOW_FROM: z.string().optional(), // comma-separated
  WORKSPACE_DIR: z.string().default("./workspace"),
  MAX_ITERATIONS: z.coerce.number().int().positive().default(50),
  MAX_TOKENS: z.coerce.number().int().positive().default(8192),
  CONTEXT_WINDOW_TOKENS: z.coerce.number().int().positive().default(65536),
  MAX_TOOL_RESULT_CHARS: z.coerce.number().int().positive().default(16000),
  HEARTBEAT_INTERVAL_S: z.coerce.number().int().positive().default(1800),
});

export type RawConfig = z.infer<typeof ConfigSchema>;

let _config: AppConfig | null = null;

export interface AppConfig {
  modelApiKey: string;
  modelApiBase: string;
  modelName: string;
  telegramBotToken?: string;
  telegramAllowFrom: string[];
  workspaceDir: string;
  maxIterations: number;
  maxTokens: number;
  contextWindowTokens: number;
  maxToolResultChars: number;
  heartbeatIntervalMs: number;
}

export function loadConfig(): AppConfig {
  if (_config) return _config;
  const raw = ConfigSchema.parse(process.env);
  _config = {
    modelApiKey: raw.MODEL_API_KEY,
    modelApiBase: raw.MODEL_API_BASE,
    modelName: raw.MODEL_NAME,
    telegramBotToken: raw.TELEGRAM_BOT_TOKEN,
    telegramAllowFrom: raw.TELEGRAM_ALLOW_FROM
      ? raw.TELEGRAM_ALLOW_FROM.split(",").map((s) => s.trim()).filter(Boolean)
      : [],
    workspaceDir: resolve(raw.WORKSPACE_DIR),
    maxIterations: raw.MAX_ITERATIONS,
    maxTokens: raw.MAX_TOKENS,
    contextWindowTokens: raw.CONTEXT_WINDOW_TOKENS,
    maxToolResultChars: raw.MAX_TOOL_RESULT_CHARS,
    heartbeatIntervalMs: raw.HEARTBEAT_INTERVAL_S * 1000,
  };
  return _config;
}
