import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import { execSync } from "node:child_process";
import { Logger } from "../logger.js";

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

// ── Module-level binary availability cache ──────────────────────────────────
// `which <bin>` shells out a process every call; we only need to ask once per
// run since binaries don't appear/disappear during a session.
const binAvailableCache = new Map<string, boolean>();
function binAvailable(cmd: string): boolean {
  const cached = binAvailableCache.get(cmd);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    execSync(`which ${cmd}`, { stdio: "ignore" });
    ok = true;
  } catch {
    ok = false;
  }
  binAvailableCache.set(cmd, ok);
  return ok;
}

function envAvailable(key: string): boolean {
  return Boolean(process.env[key]);
}

interface CachedSkill {
  meta: SkillMeta;
  rawContent: string;
  mtimeMs: number;
}

interface CachedListing {
  skills: SkillEntry[];
  /** Composite signature: dir mtimes + sorted skill paths. */
  signature: string;
}

export class SkillsLoader {
  private workspaceSkillsDir: string;
  /** path -> parsed meta + raw content, keyed by file mtime. */
  private skillCache = new Map<string, CachedSkill>();
  /** Cached output of listSkills(), invalidated when either dir mtime changes. */
  private listingCache: CachedListing | null = null;

  constructor(private workspaceDir: string) {
    this.workspaceSkillsDir = join(workspaceDir, "skills");
  }

  /**
   * Public revision token for outer caches (e.g. ContextBuilder) to key on.
   * Changes whenever any skill file or directory has been added/removed/edited.
   */
  revision(): string {
    return this.currentListingSignature();
  }

  /** List all skill entries from workspace then builtins. */
  listSkills(): SkillEntry[] {
    const sig = this.currentListingSignature();
    if (this.listingCache && this.listingCache.signature === sig) {
      return this.listingCache.skills;
    }

    const skills: SkillEntry[] = [];
    const seenNames = new Set<string>();

    // Workspace skills take priority.
    for (const entry of this.entriesFrom(this.workspaceSkillsDir, "workspace")) {
      skills.push(entry);
      seenNames.add(entry.name);
    }
    // Builtin skills (skip if overridden by workspace).
    if (existsSync(BUILTIN_SKILLS_DIR)) {
      for (const entry of this.entriesFrom(BUILTIN_SKILLS_DIR, "builtin")) {
        if (!seenNames.has(entry.name)) skills.push(entry);
      }
    }

    this.listingCache = { skills, signature: sig };
    return skills;
  }

  private entriesFrom(base: string, source: "workspace" | "builtin"): SkillEntry[] {
    if (!existsSync(base)) return [];
    try {
      return readdirSync(base, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => ({ name: d.name, path: join(base, d.name, "SKILL.md"), source }))
        .filter((e) => existsSync(e.path));
    } catch {
      return [];
    }
  }

  /** Combined signature of both skill roots (mtime + sorted child names). */
  private currentListingSignature(): string {
    const parts: string[] = [];
    for (const dir of [this.workspaceSkillsDir, BUILTIN_SKILLS_DIR]) {
      if (!existsSync(dir)) {
        parts.push(`${dir}:none`);
        continue;
      }
      try {
        const dirStat = statSync(dir);
        const children = readdirSync(dir).sort().join(",");
        parts.push(`${dir}:${dirStat.mtimeMs}:${children}`);
      } catch {
        parts.push(`${dir}:err`);
      }
    }
    return parts.join("|");
  }

  /** Load a skill's raw content (with frontmatter). Cached by mtime. */
  loadSkill(name: string): string | null {
    const cached = this.loadCachedSkillByName(name);
    return cached?.rawContent ?? null;
  }

  getSkillMeta(name: string): SkillMeta {
    const cached = this.loadCachedSkillByName(name);
    return cached?.meta ?? {};
  }

  /** Try workspace first, then builtin. Cache hit when path mtime is unchanged. */
  private loadCachedSkillByName(name: string): CachedSkill | null {
    for (const base of [this.workspaceSkillsDir, BUILTIN_SKILLS_DIR]) {
      const path = join(base, name, "SKILL.md");
      const cached = this.loadCachedSkill(path);
      if (cached) return cached;
    }
    return null;
  }

  private loadCachedSkill(path: string): CachedSkill | null {
    if (!existsSync(path)) return null;
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      return null;
    }
    const cached = this.skillCache.get(path);
    if (cached && cached.mtimeMs === mtimeMs) return cached;

    let rawContent: string;
    try {
      rawContent = readFileSync(path, "utf-8");
    } catch {
      return null;
    }
    let meta: SkillMeta = {};
    try {
      meta = matter(rawContent).data as SkillMeta;
    } catch {
      meta = {};
    }
    const entry: CachedSkill = { meta, rawContent, mtimeMs };
    this.skillCache.set(path, entry);
    return entry;
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
    } catch {
      return content;
    }
  }

  loadSkillsForContext(names: string[]): string {
    const logger = Logger.get();
    if (names.length > 0) {
      logger.info("Skills", `Loading skills: ${names.join(", ")}`);
    }
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
