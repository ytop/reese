import {
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { Tool } from "./base.js";

// ── grep ───────────────────────────────────────────────────────────────────

export class GrepTool implements Tool {
  readonly name = "grep";
  readonly description =
    "Search for a regex pattern in files. Returns matching lines with file:line format.";
  readonly concurrencySafe = true;
  readonly parameters = {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex pattern to search for" },
      path: { type: "string", description: "File or directory to search in" },
      recursive: { type: "boolean", description: "Search subdirectories (default true)" },
      case_insensitive: { type: "boolean", description: "Case insensitive (default false)" },
      max_results: { type: "number", description: "Max results (default 50)", minimum: 1 },
    },
    required: ["pattern", "path"],
  };

  constructor(private workspaceDir: string) {}

  async execute(args: Record<string, unknown>): Promise<string> {
    const pattern = args.pattern as string;
    const searchPath = args.path as string;
    const recursive = (args.recursive as boolean | undefined) ?? true;
    const caseInsensitive = (args.case_insensitive as boolean | undefined) ?? false;
    const maxResults = (args.max_results as number | undefined) ?? 50;

    try {
      const flags = caseInsensitive ? "gi" : "g";
      const regex = new RegExp(pattern, flags);
      const absPath = searchPath.startsWith("/")
        ? searchPath
        : join(this.workspaceDir, searchPath);

      if (!existsSync(absPath)) return `Error: Path not found: ${searchPath}`;

      const results: string[] = [];
      const searchFile = (fp: string) => {
        if (results.length >= maxResults) return;
        try {
          const content = readFileSync(fp, "utf-8");
          const lines = content.split("\n");
          lines.forEach((line, i) => {
            if (results.length >= maxResults) return;
            if (regex.test(line)) {
              regex.lastIndex = 0;
              results.push(`${fp}:${i + 1}: ${line}`);
            }
            regex.lastIndex = 0;
          });
        } catch { /* skip unreadable files */ }
      };

      const searchDir = (dir: string) => {
        if (results.length >= maxResults) return;
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if ([".git", "node_modules", "__pycache__"].includes(entry.name)) continue;
          const full = join(dir, entry.name);
          if (entry.isDirectory() && recursive) {
            searchDir(full);
          } else if (entry.isFile()) {
            searchFile(full);
          }
        }
      };

      const stat = statSync(absPath);
      if (stat.isDirectory()) searchDir(absPath);
      else searchFile(absPath);

      if (!results.length) return `No matches for "${pattern}" in ${searchPath}`;
      let out = results.join("\n");
      if (results.length >= maxResults) out += `\n\n(truncated at ${maxResults} results)`;
      return out;
    } catch (err: unknown) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

// ── glob ───────────────────────────────────────────────────────────────────

export class GlobTool implements Tool {
  readonly name = "glob";
  readonly description =
    "Find files matching a glob pattern (uses simple recursive scan). " +
    "Patterns: *.ts, **/*.md, src/**/*.ts";
  readonly concurrencySafe = true;
  readonly parameters = {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob-like pattern to match" },
      path: { type: "string", description: "Base directory (default: workspace)" },
      max_results: { type: "number", description: "Max results (default 100)", minimum: 1 },
    },
    required: ["pattern"],
  };

  constructor(private workspaceDir: string) {}

  async execute(args: Record<string, unknown>): Promise<string> {
    const pattern = args.pattern as string;
    const basePath = (args.path as string | undefined) ?? this.workspaceDir;
    const maxResults = (args.max_results as number | undefined) ?? 100;

    try {
      const absBase = basePath.startsWith("/")
        ? basePath
        : join(this.workspaceDir, basePath);

      // Convert glob to regex
      const regexStr = pattern
        .replace(/\*\*\//g, "(.+/)?")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]")
        .replace(/\./g, "\\.");
      const regex = new RegExp(`^${regexStr}$`);

      const results: string[] = [];
      const scan = (dir: string) => {
        if (results.length >= maxResults) return;
        let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
        try { entries = (readdirSync(dir, { withFileTypes: true }) as unknown) as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>; }
        catch { return; }
        for (const entry of entries) {
          if ([".git", "node_modules", "__pycache__"].includes(entry.name)) continue;
          const full = join(dir, entry.name);
          const rel = resolve(full).slice(resolve(absBase).length + 1);
          if (entry.isFile() && regex.test(rel)) {
            results.push(full);
          }
          if (entry.isDirectory()) scan(full);
        }
      };

      if (!existsSync(absBase)) return `Error: Path not found: ${basePath}`;
      scan(absBase);
      if (!results.length) return `No files match "${pattern}" in ${basePath}`;
      let out = results.join("\n");
      if (results.length >= maxResults) out += `\n\n(truncated at ${maxResults} results)`;
      return out;
    } catch (err: unknown) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
