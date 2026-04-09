import { mkdirSync } from "node:fs";
import { join } from "node:path";

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function workspacePaths(workspaceDir: string) {
  const memory = join(workspaceDir, "memory");
  const sessions = join(workspaceDir, "sessions");
  const skills = join(workspaceDir, "skills");
  const media = join(workspaceDir, "media");
  return {
    root: workspaceDir,
    memory,
    sessions,
    skills,
    media,
    soulFile: join(workspaceDir, "SOUL.md"),
    userFile: join(workspaceDir, "USER.md"),
    agentsFile: join(workspaceDir, "AGENTS.md"),
    heartbeatFile: join(workspaceDir, "HEARTBEAT.md"),
    memoryFile: join(memory, "MEMORY.md"),
    historyFile: join(memory, "history.jsonl"),
    cursorFile: join(memory, ".cursor"),
    dreamCursorFile: join(memory, ".dream_cursor"),
  };
}

export function ensureWorkspace(workspaceDir: string) {
  const paths = workspacePaths(workspaceDir);
  ensureDir(paths.root);
  ensureDir(paths.memory);
  ensureDir(paths.sessions);
  ensureDir(paths.skills);
  ensureDir(paths.media);
  return paths;
}
