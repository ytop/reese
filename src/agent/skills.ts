import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import { execSync } from "node:child_process";

/** Built-in skills dir (relative to project root, resolved at runtime). */
export const BUILTIN_SKILLS_DIR = join(
  new URL("../../skills", import.meta.url).pathname
);

export interface SkillEntry {
  name: string;
  path: string;
  source: "workspace" | "builtin";
}

export interface SkillMeta {
  name?: string;
  description?: string;
  version?: string;
  requires?: {
    bins?: string[];
    env?: string[];
  };
  always?: boolean;
}

function binAvailable(cmd: string): boolean {
  try { execSync(`which ${cmd}`, { stdio: "ignore" }); return true; }
  catch { return false; }
}

function envAvailable(key: string): boolean {
  return Boolean(process.env[key]);
}

export class SkillsLoader {
  private workspaceSkillsDir: string;

  constructor(private workspaceDir: string) {
    this.workspaceSkillsDir = join(workspaceDir, "skills");
  }

  /** List all skill entries from workspace then builtins. */
  listSkills(): SkillEntry[] {
    const skills: SkillEntry[] = [];
    const seenNames = new Set<string>();

    // Workspace skills take priority
    for (const entry of this.entriesFrom(this.workspaceSkillsDir, "workspace")) {
      skills.push(entry);
      seenNames.add(entry.name);
    }

    // Builtin skills (skip if overridden by workspace)
    if (existsSync(BUILTIN_SKILLS_DIR)) {
      for (const entry of this.entriesFrom(BUILTIN_SKILLS_DIR, "builtin")) {
        if (!seenNames.has(entry.name)) {
          skills.push(entry);
        }
      }
    }

    return skills;
  }

  private entriesFrom(base: string, source: "workspace" | "builtin"): SkillEntry[] {
    if (!existsSync(base)) return [];
    try {
      return readdirSync(base, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => ({ name: d.name, path: join(base, d.name, "SKILL.md"), source }))
        .filter((e) => existsSync(e.path));
    } catch { return []; }
  }

  loadSkill(name: string): string | null {
    for (const base of [this.workspaceSkillsDir, BUILTIN_SKILLS_DIR]) {
      const path = join(base, name, "SKILL.md");
      if (existsSync(path)) return readFileSync(path, "utf-8");
    }
    return null;
  }

  getSkillMeta(name: string): SkillMeta {
    const raw = this.loadSkill(name);
    if (!raw) return {};
    try {
      const parsed = matter(raw);
      return parsed.data as SkillMeta;
    } catch { return {}; }
  }

  isAvailable(meta: SkillMeta): boolean {
    const bins = meta.requires?.bins ?? [];
    const envs = meta.requires?.env ?? [];
    return bins.every(binAvailable) && envs.every(envAvailable);
  }

  getAlwaysSkills(): string[] {
    return this.listSkills()
      .filter((e) => {
        const meta = this.getSkillMeta(e.name);
        return meta.always && this.isAvailable(meta);
      })
      .map((e) => e.name);
  }

  /** Build XML summary for context injection. */
  buildSkillsSummary(): string {
    const skills = this.listSkills();
    if (!skills.length) return "";
    const lines = ["<skills>"];
    for (const entry of skills) {
      const meta = this.getSkillMeta(entry.name);
      const available = this.isAvailable(meta);
      lines.push(`  <skill available="${available}">`);
      lines.push(`    <name>${entry.name}</name>`);
      lines.push(`    <description>${escapeXml(meta.description ?? entry.name)}</description>`);
      lines.push(`    <location>${entry.path}</location>`);
      if (!available) {
        const missingBins = (meta.requires?.bins ?? []).filter((b) => !binAvailable(b));
        const missingEnvs = (meta.requires?.env ?? []).filter((e) => !envAvailable(e));
        const missing = [
          ...missingBins.map((b) => `CLI: ${b}`),
          ...missingEnvs.map((e) => `ENV: ${e}`),
        ].join(", ");
        if (missing) lines.push(`    <requires>${escapeXml(missing)}</requires>`);
      }
      lines.push("  </skill>");
    }
    lines.push("</skills>");
    return lines.join("\n");
  }

  /** Strip YAML frontmatter from a skill's content. */
  stripFrontmatter(content: string): string {
    try {
      return matter(content).content.trim();
    } catch { return content; }
  }

  loadSkillsForContext(names: string[]): string {
    return names
      .map((name) => {
        const raw = this.loadSkill(name);
        if (!raw) return null;
        return `### Skill: ${name}\n\n${this.stripFrontmatter(raw)}`;
      })
      .filter(Boolean)
      .join("\n\n---\n\n");
  }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
