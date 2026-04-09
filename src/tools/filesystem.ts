import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
  type Dirent,
} from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import type { Tool } from "./base.js";

const MAX_READ_CHARS = 128_000;
const DEFAULT_LINE_LIMIT = 2000;

function resolvePath(path: string, workspaceDir: string, allowedDir?: string): string {
  let p = path;
  if (!p.startsWith("/")) p = join(workspaceDir, p);
  const resolved = resolve(p);
  if (allowedDir) {
    const allowed = resolve(allowedDir);
    if (!resolved.startsWith(allowed + "/") && resolved !== allowed) {
      throw new Error(`Path "${path}" is outside the allowed directory`);
    }
  }
  return resolved;
}

// ── read_file ──────────────────────────────────────────────────────────────

export class ReadFileTool implements Tool {
  readonly name = "read_file";
  readonly description =
    "Read a text file. Output format: LINE|CONTENT. " +
    "Use offset and limit for large files. Reads exceeding ~128K chars are truncated.";
  readonly concurrencySafe = true;
  readonly parameters = {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to read" },
      offset: { type: "number", description: "Start line (1-indexed, default 1)", minimum: 1 },
      limit: { type: "number", description: "Max lines to read (default 2000)", minimum: 1 },
    },
    required: ["path"],
  };

  constructor(private workspaceDir: string, private allowedDir?: string) {}

  async execute(args: Record<string, unknown>): Promise<string> {
    const path = args.path as string;
    const offset = (args.offset as number | undefined) ?? 1;
    const limit = (args.limit as number | undefined) ?? DEFAULT_LINE_LIMIT;
    try {
      const fp = resolvePath(path, this.workspaceDir, this.allowedDir);
      if (!existsSync(fp)) return `Error: File not found: ${path}`;
      const stat = statSync(fp);
      if (!stat.isFile()) return `Error: Not a file: ${path}`;
      const text = readFileSync(fp, "utf-8");
      if (!text) return `(Empty file: ${path})`;

      const lines = text.split("\n");
      const total = lines.length;
      const start = Math.max(0, offset - 1);
      if (start >= total) return `Error: offset ${offset} beyond end (${total} lines)`;
      const end = Math.min(start + limit, total);
      let numbered = lines.slice(start, end).map((l, i) => `${start + i + 1}| ${l}`).join("\n");
      if (numbered.length > MAX_READ_CHARS) {
        numbered = numbered.slice(0, MAX_READ_CHARS) + "\n[truncated]";
      }
      const footer =
        end < total
          ? `\n\n(Showing lines ${offset}-${end} of ${total}. Use offset=${end + 1} to continue.)`
          : `\n\n(End of file — ${total} lines total)`;
      return numbered + footer;
    } catch (err: unknown) {
      return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

// ── write_file ─────────────────────────────────────────────────────────────

export class WriteFileTool implements Tool {
  readonly name = "write_file";
  readonly description =
    "Write content to a file. Overwrites if it exists; creates parent dirs as needed.";
  readonly parameters = {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to write" },
      content: { type: "string", description: "Content to write" },
    },
    required: ["path", "content"],
  };

  constructor(private workspaceDir: string, private allowedDir?: string) {}

  async execute(args: Record<string, unknown>): Promise<string> {
    const path = args.path as string;
    const content = args.content as string;
    try {
      const fp = resolvePath(path, this.workspaceDir, this.allowedDir);
      mkdirSync(dirname(fp), { recursive: true });
      writeFileSync(fp, content, "utf-8");
      return `Successfully wrote ${content.length} characters to ${fp}`;
    } catch (err: unknown) {
      return `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

// ── edit_file ──────────────────────────────────────────────────────────────

function findMatch(content: string, oldText: string): [string | null, number] {
  if (content.includes(oldText)) return [oldText, content.split(oldText).length - 1];
  // Whitespace-tolerant line-by-line match
  const oldLines = oldText.split("\n");
  const contentLines = content.split("\n");
  const stripped = oldLines.map((l) => l.trim());
  const candidates: string[] = [];
  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    const window = contentLines.slice(i, i + oldLines.length);
    if (window.map((l) => l.trim()).join("|") === stripped.join("|")) {
      candidates.push(window.join("\n"));
    }
  }
  if (candidates.length) return [candidates[0], candidates.length];
  return [null, 0];
}

export class EditFileTool implements Tool {
  readonly name = "edit_file";
  readonly description =
    "Edit a file by replacing old_text with new_text. " +
    "Tolerates minor whitespace differences. " +
    "If old_text matches multiple times, set replace_all=true or add more context.";
  readonly parameters = {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to edit" },
      old_text: { type: "string", description: "Text to find and replace" },
      new_text: { type: "string", description: "Replacement text" },
      replace_all: { type: "boolean", description: "Replace all occurrences (default false)" },
    },
    required: ["path", "old_text", "new_text"],
  };

  constructor(private workspaceDir: string, private allowedDir?: string) {}

  async execute(args: Record<string, unknown>): Promise<string> {
    const path = args.path as string;
    const oldText = args.old_text as string;
    const newText = args.new_text as string;
    const replaceAll = (args.replace_all as boolean | undefined) ?? false;
    try {
      const fp = resolvePath(path, this.workspaceDir, this.allowedDir);
      if (!existsSync(fp)) return `Error: File not found: ${path}`;
      const content = readFileSync(fp, "utf-8").replace(/\r\n/g, "\n");
      const [match, count] = findMatch(content, oldText.replace(/\r\n/g, "\n"));
      if (!match) return `Error: old_text not found in ${path}. Verify content matches exactly.`;
      if (count > 1 && !replaceAll) {
        return `Warning: old_text appears ${count} times. Add context to make it unique, or set replace_all=true.`;
      }
      const updated = replaceAll
        ? content.split(match).join(newText)
        : content.replace(match, newText);
      writeFileSync(fp, updated, "utf-8");
      return `Successfully edited ${fp}`;
    } catch (err: unknown) {
      return `Error editing file: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

// ── list_dir ───────────────────────────────────────────────────────────────

const IGNORE_DIRS = new Set([
  ".git", "node_modules", "__pycache__", ".venv", "venv",
  "dist", "build", ".tox", ".mypy_cache", ".pytest_cache",
]);

export class ListDirTool implements Tool {
  readonly name = "list_dir";
  readonly description =
    "List directory contents. Set recursive=true to explore nested structure. " +
    "Common noise dirs (.git, node_modules, etc.) are auto-ignored.";
  readonly concurrencySafe = true;
  readonly parameters = {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path" },
      recursive: { type: "boolean", description: "List recursively (default false)" },
      max_entries: { type: "number", description: "Max entries to return (default 200)", minimum: 1 },
    },
    required: ["path"],
  };

  constructor(private workspaceDir: string, private allowedDir?: string) {}

  async execute(args: Record<string, unknown>): Promise<string> {
    const path = args.path as string;
    const recursive = (args.recursive as boolean | undefined) ?? false;
    const maxEntries = (args.max_entries as number | undefined) ?? 200;
    try {
      const dp = resolvePath(path, this.workspaceDir, this.allowedDir);
      if (!existsSync(dp)) return `Error: Directory not found: ${path}`;
      const stat = statSync(dp);
      if (!stat.isDirectory()) return `Error: Not a directory: ${path}`;

      const items: string[] = [];
      let total = 0;

      const collect = (dir: string, prefix: string) => {
        const entries: Dirent[] = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (IGNORE_DIRS.has(entry.name)) continue;
          total++;
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (items.length < maxEntries) {
            items.push(entry.isDirectory() ? `📁 ${rel}/` : `📄 ${rel}`);
          }
          if (recursive && entry.isDirectory()) {
            collect(join(dir, entry.name), rel);
          }
        }
      };
      collect(dp, "");

      if (total === 0) return `Directory ${path} is empty`;
      let result = items.join("\n");
      if (total > maxEntries) result += `\n\n(showing first ${maxEntries} of ${total} entries)`;
      return result;
    } catch (err: unknown) {
      return `Error listing directory: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
