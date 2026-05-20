#!/usr/bin/env bun
/**
 * Quick instrument: builds a representative request payload using the
 * production code paths (ContextBuilder + ToolRegistry) and prints a
 * per-component token estimate so we can confirm <2K targets are met.
 *
 * Run: bun scripts/measure-prompt.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextBuilder } from "../src/agent/context.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { ReadFileTool, WriteFileTool, EditFileTool, ListDirTool } from "../src/tools/filesystem.js";
import { ExecTool } from "../src/tools/shell.js";
import { GrepTool, GlobTool } from "../src/tools/search.js";
import { WebFetchTool, WebSearchTool } from "../src/tools/web.js";
import { MessageTool } from "../src/tools/message.js";

function tokens(s: string): number { return Math.round(s.length / 4); }

function makeWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), "reese-measure-"));
  mkdirSync(join(ws, "memory"), { recursive: true });
  mkdirSync(join(ws, "skills"), { recursive: true });
  // Modest USER.md and MEMORY.md so we measure a realistic non-cold case.
  writeFileSync(
    join(ws, "USER.md"),
    "Name: Jon. Prefers concise answers. Lives in PT timezone. Uses Bun + TypeScript.\n"
  );
  writeFileSync(
    join(ws, "memory", "MEMORY.md"),
    "Recent: shipped reese channels manager. Prefers small-context model. Uses /think for hard tasks.\n"
  );
  return ws;
}

function buildAllTools(ws: string): ToolRegistry {
  const r = new ToolRegistry();
  r.register(new ReadFileTool(ws));
  r.register(new WriteFileTool(ws));
  r.register(new EditFileTool(ws));
  r.register(new ListDirTool(ws));
  r.register(new ExecTool(ws));
  r.register(new GrepTool(ws));
  r.register(new GlobTool(ws));
  r.register(new WebFetchTool());
  r.register(new WebSearchTool());
  r.register(new MessageTool(() => {}));
  return r;
}

function buildSelectedTools(ws: string, names: string[]): ToolRegistry {
  const all = buildAllTools(ws);
  const sub = new ToolRegistry();
  for (const n of names) {
    const t = all.get(n);
    if (t) sub.register(t);
  }
  return sub;
}

function report(label: string, sys: string, history: string[], userMsg: string, tools: ToolRegistry) {
  const sysT = tokens(sys);
  const histT = tokens(history.join(""));
  const userT = tokens(userMsg);
  const toolsT = tokens(JSON.stringify(tools.getDefinitions()));
  const total = sysT + histT + userT + toolsT;
  console.log(`\n— ${label} —`);
  console.log(`  system : ${sysT.toString().padStart(5)}t  (${sys.length} chars)`);
  console.log(`  history: ${histT.toString().padStart(5)}t`);
  console.log(`  user   : ${userT.toString().padStart(5)}t`);
  console.log(`  tools  : ${toolsT.toString().padStart(5)}t  (${tools.getDefinitions().length} schemas)`);
  console.log(`  TOTAL  : ${total.toString().padStart(5)}t  ${total <= 2000 ? "✅ under 2K" : "❌ over 2K"}`);
}

async function main() {
  const ws = makeWorkspace();
  const ctx = new ContextBuilder(ws);

  // Scenario 1: cold first turn, file-related question
  {
    const userMsg = "show me what's in src/agent/loop.ts";
    const messages = ctx.buildCompactMessages(undefined, [], userMsg, {
      channel: "telegram",
      chatId: "12345",
      budgetChars: 1000,
    });
    const sys = typeof messages[0].content === "string" ? messages[0].content : "";
    const user = typeof messages[messages.length - 1].content === "string" ? messages[messages.length - 1].content as string : "";
    const tools = buildSelectedTools(ws, ["message", "read_file", "list_dir"]);
    report("Cold turn — read file", sys, [], user, tools);
  }

  // Scenario 2: mid-session with summary, write-style request
  {
    const summary =
      "User asked Reese to optimize prompt size. Reese audited the system prompt and tool schemas, " +
      "trimmed boilerplate, and added a configurable budget. Pending work: ship and measure.";
    const recentHistory = [
      { role: "user" as const, content: "ok now apply the trims" },
      { role: "assistant" as const, content: "Done — committed." },
    ];
    const userMsg = "edit src/agent/loop.ts to bump the consolidation cap to 8";
    const messages = ctx.buildCompactMessages(summary, recentHistory, userMsg, {
      channel: "cli",
      chatId: "direct",
      budgetChars: 1000,
    });
    const sys = typeof messages[0].content === "string" ? messages[0].content : "";
    const histStrs = messages.slice(1, -1).map((m) => (typeof m.content === "string" ? m.content : ""));
    const user = typeof messages[messages.length - 1].content === "string" ? messages[messages.length - 1].content as string : "";
    const tools = buildSelectedTools(ws, ["message", "read_file", "write_file", "edit_file"]);
    report("Mid-session — edit file (with summary)", sys, histStrs, user, tools);
  }

  // Scenario 3: web-related question
  {
    const userMsg = "fetch https://example.com and summarize";
    const messages = ctx.buildCompactMessages(undefined, [], userMsg, {
      channel: "telegram",
      chatId: "12345",
      budgetChars: 1000,
    });
    const sys = typeof messages[0].content === "string" ? messages[0].content : "";
    const user = typeof messages[messages.length - 1].content === "string" ? messages[messages.length - 1].content as string : "";
    const tools = buildSelectedTools(ws, ["message", "web_fetch"]);
    report("Web fetch", sys, [], user, tools);
  }

  // Scenario 4: shell command
  {
    const userMsg = "run npm test";
    const messages = ctx.buildCompactMessages(undefined, [], userMsg, {
      channel: "cli",
      chatId: "direct",
      budgetChars: 1000,
    });
    const sys = typeof messages[0].content === "string" ? messages[0].content : "";
    const user = typeof messages[messages.length - 1].content === "string" ? messages[messages.length - 1].content as string : "";
    const tools = buildSelectedTools(ws, ["message", "exec"]);
    report("Shell exec", sys, [], user, tools);
  }

  // Scenario 5: worst case — ALL tools (regression baseline)
  {
    const userMsg = "audit the codebase end-to-end and search for TODO patterns then write a report and run tests";
    const messages = ctx.buildCompactMessages(undefined, [], userMsg, {
      channel: "cli",
      chatId: "direct",
      budgetChars: 1000,
    });
    const sys = typeof messages[0].content === "string" ? messages[0].content : "";
    const user = typeof messages[messages.length - 1].content === "string" ? messages[messages.length - 1].content as string : "";
    const tools = buildAllTools(ws);
    report("Worst case — all 10 schemas", sys, [], user, tools);
  }
}

main();
