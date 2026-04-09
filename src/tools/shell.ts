import { spawnSync } from "node:child_process";
import type { Tool } from "./base.js";

export class ExecTool implements Tool {
  readonly name = "exec";
  readonly description =
    "Execute a shell command and return its stdout+stderr output. " +
    "Use for running scripts, git commands, package managers, etc.";
  readonly parameters = {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to run" },
      timeout: { type: "number", description: "Timeout in seconds (default 30)", minimum: 1 },
      cwd: { type: "string", description: "Working directory (default: workspace)" },
    },
    required: ["command"],
  };

  constructor(private workspaceDir: string) {}

  async execute(args: Record<string, unknown>): Promise<string> {
    const command = args.command as string;
    const timeout = ((args.timeout as number | undefined) ?? 30) * 1000;
    const cwd = (args.cwd as string | undefined) ?? this.workspaceDir;

    try {
      const result = spawnSync("bash", ["-c", command], {
        cwd,
        timeout,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024, // 10MB
        env: { ...process.env, TERM: "dumb" },
      });

      const stdout = result.stdout?.trim() ?? "";
      const stderr = result.stderr?.trim() ?? "";
      const exitCode = result.status ?? -1;

      let output = "";
      if (stdout) output += stdout;
      if (stderr) output += (output ? "\n[stderr]\n" : "") + stderr;
      if (!output) output = exitCode === 0 ? "(no output)" : "";

      if (exitCode !== 0) {
        return `Exit code: ${exitCode}\n${output}`;
      }
      return output || "(no output)";
    } catch (err: unknown) {
      return `Error executing command: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
