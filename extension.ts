/**
 * wezterm-dispatch — Dispatch tasks to multiple pi agents in WezTerm panes/tabs.
 *
 * Features:
 *   - Grid pane layout (see all agents working at once)
 *   - Live status widget + auto-notifications when agents finish
 *   - Dispatch templates for common workflows
 *   - Result collection back into the main session
 *
 * Tools:
 *   list_dispatch_agents      — List available agents
 *   list_dispatch_templates   — List pre-configured dispatch templates
 *   wezterm_dispatch          — Dispatch agents to WezTerm panes
 *   dispatch_from_template    — Dispatch using a template
 *   collect_dispatch_results  — Collect agent results
 *
 * Commands:
 *   /dispatch [template]  — Dispatch agents (optionally from a template)
 *   /collect              — Collect results from last dispatch
 *   /status               — Show dispatch status
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { execFile } from "node:child_process";

// ════════════════════════════════════════════════════════════════
//  Constants
// ════════════════════════════════════════════════════════════════

const RESULTS_BASE_DIR = join(homedir(), ".pi", "dispatch-results");
const TEMPLATES_DIR = join(homedir(), ".pi", "agent", "dispatch-templates");
const MANIFEST_FILE = "manifest.json";
const POLL_INTERVAL_MS = 5_000;

// ════════════════════════════════════════════════════════════════
//  Types
// ════════════════════════════════════════════════════════════════

interface AgentSummary {
  name: string;
  display_name: string;
  description: string;
  model: string;
  thinking: string;
  max_turns: number;
  tools: string[];
  prompt_mode: string;
  source: "project" | "global";
  system_prompt_preview: string;
}

interface ManifestAgent {
  name: string;
  displayName: string;
  model: string;
  prompt: string;
  resultFile: string;
  paneId?: string;
}

interface DispatchManifest {
  taskId: string;
  taskSummary: string;
  dispatchedAt: string;
  workingDir: string;
  layout: string;
  agents: ManifestAgent[];
}

interface DispatchTemplate {
  name: string;
  display_name: string;
  description: string;
  layout: string;
  agents: { name: string; promptTemplate: string }[];
}

// ════════════════════════════════════════════════════════════════
//  Live status tracking (module-level state)
// ════════════════════════════════════════════════════════════════

let activeDispatch: {
  taskId: string;
  manifest: DispatchManifest;
  completedAgents: Set<string>;
  notifiedAgents: Set<string>;
  allDoneNotified: boolean;
} | null = null;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pendingNotifications: string[] = [];
const tempFiles = new Set<string>();

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (!activeDispatch) return;
    for (const agent of activeDispatch.manifest.agents) {
      if (!activeDispatch.completedAgents.has(agent.name) && existsSync(agent.resultFile)) {
        activeDispatch.completedAgents.add(agent.name);
        if (!activeDispatch.notifiedAgents.has(agent.name)) {
          activeDispatch.notifiedAgents.add(agent.name);
          pendingNotifications.push(`Agent "${agent.displayName}" finished`);
        }
      }
    }
    const total = activeDispatch.manifest.agents.length;
    const done = activeDispatch.completedAgents.size;
    if (done === total && !activeDispatch.allDoneNotified) {
      activeDispatch.allDoneNotified = true;
      pendingNotifications.push(`All ${total} agents completed! Use /collect to gather results.`);
      stopPolling();
    }
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function getStatusLines(): string[] {
  if (!activeDispatch) return ["No active dispatch"];
  const lines: string[] = [];
  const m = activeDispatch.manifest;
  lines.push(`Task: ${m.taskSummary}`);
  for (const agent of m.agents) {
    const done = activeDispatch.completedAgents.has(agent.name);
    const icon = done ? "[done]" : "[...]";
    lines.push(`  ${icon} ${agent.displayName} (${agent.model})`);
  }
  const total = m.agents.length;
  const completed = activeDispatch.completedAgents.size;
  lines.push(`Progress: ${completed}/${total}`);
  return lines;
}

// ════════════════════════════════════════════════════════════════
//  Agent discovery
// ════════════════════════════════════════════════════════════════

function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };
  const fm: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { frontmatter: fm, body: match[2] };
}

function loadAgentsFromDir(dir: string, source: "project" | "global"): AgentSummary[] {
  if (!existsSync(dir)) return [];
  let files: string[];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".md")); } catch { return []; }

  const agents: AgentSummary[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(dir, file), "utf-8");
      const { frontmatter: fm, body } = parseFrontmatter(content);
      if (fm.enabled === "false") continue;
      agents.push({
        name: fm.name || basename(file, ".md"),
        display_name: fm.display_name || fm.name || basename(file, ".md"),
        description: fm.description || "",
        model: fm.model || "anthropic/claude-sonnet-4-6",
        thinking: fm.thinking || "off",
        max_turns: parseInt(fm.max_turns || "10", 10),
        tools: (fm.tools || "read,bash,grep,find,ls").split(",").map((t) => t.trim()),
        prompt_mode: fm.prompt_mode || "append",
        source,
        system_prompt_preview: body.trim().slice(0, 200) + (body.trim().length > 200 ? "..." : ""),
      });
    } catch (err) { console.warn(`[wezterm-dispatch] Failed to load agent ${file}:`, err); continue; }
  }
  return agents;
}

function loadAllAgents(cwd: string): AgentSummary[] {
  const globalDir = join(homedir(), ".pi", "agent", "agents");
  const projectDir = join(cwd, ".pi", "agents");
  const byName = new Map<string, AgentSummary>();
  for (const a of loadAgentsFromDir(globalDir, "global")) byName.set(a.name, a);
  for (const a of loadAgentsFromDir(projectDir, "project")) byName.set(a.name, a);
  return [...byName.values()];
}

// ════════════════════════════════════════════════════════════════
//  Template discovery
// ════════════════════════════════════════════════════════════════

function loadTemplates(): DispatchTemplate[] {
  if (!existsSync(TEMPLATES_DIR)) return [];
  let files: string[];
  try { files = readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith(".md")); } catch { return []; }

  const templates: DispatchTemplate[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(TEMPLATES_DIR, file), "utf-8");
      const { frontmatter: fm, body } = parseFrontmatter(content);

      // Parse agent sections: ## agent-name\n prompt text
      const agents: { name: string; promptTemplate: string }[] = [];
      const sections = body.split(/^## /m).filter(Boolean);
      for (const section of sections) {
        const newline = section.indexOf("\n");
        if (newline === -1) continue;
        const name = section.slice(0, newline).trim();
        const promptTemplate = section.slice(newline + 1).trim();
        if (name && promptTemplate) agents.push({ name, promptTemplate });
      }

      templates.push({
        name: fm.name || basename(file, ".md"),
        display_name: fm.display_name || fm.name || basename(file, ".md"),
        description: fm.description || "",
        layout: fm.layout || "grid",
        agents,
      });
    } catch (err) { console.warn(`[wezterm-dispatch] Failed to load template ${file}:`, err); continue; }
  }
  return templates;
}

// ════════════════════════════════════════════════════════════════
//  Dispatch state helpers
// ════════════════════════════════════════════════════════════════

function getLatestTaskId(): string | null {
  if (!existsSync(RESULTS_BASE_DIR)) return null;
  try {
    const dirs = readdirSync(RESULTS_BASE_DIR)
      .filter((d) => existsSync(join(RESULTS_BASE_DIR, d, MANIFEST_FILE)))
      .sort()
      .reverse();
    return dirs[0] || null;
  } catch { return null; }
}

function getManifest(taskId: string): DispatchManifest | null {
  const p = join(RESULTS_BASE_DIR, taskId, MANIFEST_FILE);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; }
}

// ════════════════════════════════════════════════════════════════
//  Helpers
// ════════════════════════════════════════════════════════════════

function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf-8", timeout: 15000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

function generateTaskId(): string {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}_${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
}

// ════════════════════════════════════════════════════════════════
//  Grid layout engine
// ════════════════════════════════════════════════════════════════

/**
 * Spawn N panes in a grid layout inside a new WezTerm tab.
 * Returns an array of pane IDs in the order of the agents.
 *
 * Grid strategy:
 *   1 agent  → single pane
 *   2 agents → side by side (left | right)
 *   3 agents → 2 columns: left split top/bottom, right full
 *   4 agents → 2x2 grid
 *   5-6      → 3 columns, split as needed
 *   7-9      → 3x3
 */
async function spawnGridLayout(
  count: number,
  workDir: string,
  scripts: { path: string; title: string }[]
): Promise<string[]> {
  const winWorkDir = workDir.replace(/\//g, "\\");
  const paneIds: string[] = [];

  if (count === 0) return paneIds;

  // Spawn first pane in a new tab
  const firstScript = scripts[0].path.replace(/\//g, "\\");
  const firstId = (
    await runCommand("wezterm", ["cli", "spawn", "--cwd", winWorkDir, "--", "powershell.exe", "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", firstScript])
  ).trim();
  paneIds.push(firstId);
  await runCommand("wezterm", ["cli", "set-tab-title", "--pane-id", firstId, "Dispatch"]).catch(() => {});

  if (count === 1) return paneIds;

  // Calculate grid dimensions
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);

  // Step 1: Create columns by splitting the first pane horizontally (right)
  // columnPanes[i] = pane ID for the top cell of column i
  const columnPanes: string[] = [firstId];

  for (let c = 1; c < cols; c++) {
    const percent = Math.round(100 / (cols - c + 1));
    const parentPane = columnPanes[c - 1];
    const script = scripts[c < count ? c : 0]; // fallback to first if overflow
    const scriptWin = script.path.replace(/\//g, "\\");
    const newId = (
      await runCommand("wezterm", ["cli", "split-pane", "--pane-id", parentPane, "--right", "--percent", String(percent), "--cwd", winWorkDir, "--", "powershell.exe", "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptWin])
    ).trim();
    columnPanes.push(newId);
    if (c < count) paneIds.push(newId);
  }

  // Step 2: Split each column vertically to create rows
  // Agent index mapping: column c, row r → agent index = r * cols + c
  // But we already placed the top cell of each column (row 0)
  for (let c = 0; c < cols; c++) {
    let currentPane = columnPanes[c];
    for (let r = 1; r < rows; r++) {
      const agentIdx = r * cols + c;
      if (agentIdx >= count) break;

      const percent = Math.round(100 / (rows - r + 1));
      const script = scripts[agentIdx];
      const scriptWin = script.path.replace(/\//g, "\\");
      const newId = (
        await runCommand("wezterm", ["cli", "split-pane", "--pane-id", currentPane, "--bottom", "--percent", String(percent), "--cwd", winWorkDir, "--", "powershell.exe", "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptWin])
      ).trim();
      paneIds.push(newId);
      currentPane = newId;
    }
  }

  return paneIds;
}

/**
 * Spawn panes as separate tabs (simple mode).
 */
async function spawnTabLayout(
  workDir: string,
  scripts: { path: string; title: string }[]
): Promise<string[]> {
  const winWorkDir = workDir.replace(/\//g, "\\");
  const paneIds: string[] = [];

  for (const script of scripts) {
    const scriptWin = script.path.replace(/\//g, "\\");
    const id = (
      await runCommand("wezterm", ["cli", "spawn", "--cwd", winWorkDir, "--", "powershell.exe", "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptWin])
    ).trim();
    paneIds.push(id);
    if (id) {
      await runCommand("wezterm", ["cli", "set-tab-title", "--pane-id", id, script.title]).catch(() => {});
    }
  }
  return paneIds;
}

// ════════════════════════════════════════════════════════════════
//  Core dispatch logic (shared between tool and template)
// ════════════════════════════════════════════════════════════════

interface DispatchAgent {
  name: string;
  prompt: string;
  model_override?: string;
  tab_title?: string;
}

async function executeDispatch(
  taskSummary: string,
  agents: DispatchAgent[],
  layout: "grid" | "tabs",
  workingDir: string,
  cwd: string
): Promise<{ text: string; taskId: string }> {
  const taskId = generateTaskId();
  const taskDir = join(RESULTS_BASE_DIR, taskId);
  mkdirSync(taskDir, { recursive: true });

  const allAgentDefs = loadAllAgents(cwd);
  const agentMap = new Map(allAgentDefs.map((a) => [a.name, a]));
  const manifestAgents: ManifestAgent[] = [];
  const scripts: { path: string; title: string }[] = [];
  const results: string[] = [];

  results.push(`== Task ${taskId}: ${taskSummary} ==`);
  results.push(`Layout: ${layout} | Agents: ${agents.length}\n`);

  for (const dispatch of agents) {
    const agentDef = agentMap.get(dispatch.name);
    const model = dispatch.model_override || agentDef?.model || "anthropic/claude-sonnet-4-6";
    const thinking = agentDef?.thinking || "off";
    const tabTitle = dispatch.tab_title || agentDef?.display_name || dispatch.name;
    const modelArg = thinking !== "off" ? `${model}:${thinking}` : model;

    // Result file
    const resultFilePath = join(taskDir, `${dispatch.name}.md`);
    const resultFileWin = resultFilePath.replace(/\//g, "\\");

    // Extract agent system prompt body (without frontmatter) from .md file
    let agentSystemPrompt = "";
    if (agentDef) {
      const projectPath = join(cwd, ".pi", "agents", `${dispatch.name}.md`);
      const globalPath = join(homedir(), ".pi", "agent", "agents", `${dispatch.name}.md`);
      const agentMdPath = existsSync(projectPath) ? projectPath : existsSync(globalPath) ? globalPath : null;
      if (agentMdPath) {
        const { body } = parseFrontmatter(readFileSync(agentMdPath, "utf-8"));
        agentSystemPrompt = body.trim();
      }
    }

    // Build a COMPLETE system prompt that replaces pi's default.
    // This is critical: --system-prompt replaces the default prompt so the model
    // doesn't know about Agent, sub-agents, or any dispatch tools.
    // Combined with --no-extensions, the Agent tool won't even exist.
    const systemPromptContent = [
      "You are a specialist AI coding assistant. You work directly with files and code using your tools.",
      "",
      "# Your tools",
      "You have these tools available — use them directly to do your work:",
      "- **read** — Read file contents",
      "- **bash** — Execute shell commands (ls, git, find, cat, etc.)",
      "- **grep** — Search file contents with regex",
      "- **find** — Find files by name pattern",
      "- **ls** — List directory contents",
      "- **write** — Create or overwrite files",
      "- **edit** — Edit existing files with find-and-replace",
      "",
      "# Your role",
      agentSystemPrompt || "You are a thorough analyst. Do your work directly using the tools above.",
      "",
      "# Output rules",
      "- Use absolute file paths in all references",
      "- Be thorough and precise",
      "- Do not use emojis",
      "",
      "# SAVE YOUR REPORT",
      `When you finish, you MUST save your complete report using the write tool to:`,
      `${resultFileWin}`,
      "",
      "Format as comprehensive markdown with title, organized sections, file paths,",
      "code snippets, and conclusions. YOUR WORK IS LOST if you don't save.",
    ].join("\n");

    // Write system prompt to temp file
    const scriptId = `dispatch_${dispatch.name}_${Date.now()}`;
    const systemPromptPath = join(homedir(), ".pi", "agent", `${scriptId}_system.txt`);
    writeFileSync(systemPromptPath, systemPromptContent, "utf-8");
    tempFiles.add(systemPromptPath);

    const fullPrompt = dispatch.prompt;

    // Build PowerShell script
    const scriptPath = join(homedir(), ".pi", "agent", `${scriptId}.ps1`);

    let script = `$Host.UI.RawUI.WindowTitle = '${tabTitle.replace(/'/g, "''")}'\n`;
    script += `$ErrorActionPreference = 'Continue'\n\n`;

    // --no-extensions: removes Agent tool entirely (pi-subagents won't load)
    // --no-skills: removes skill invocations
    // --system-prompt: REPLACES default prompt (model won't know about Agent tool)
    // --tools: explicitly lists available tools (these are CORE pi tools, not extensions)
    const systemPromptWin = systemPromptPath.replace(/\//g, "\\");

    const tools = new Set(agentDef?.tools?.length ? agentDef.tools : ["read", "bash", "grep", "find", "ls"]);
    tools.add("write");
    tools.add("bash");

    let piCmd = `pi --no-extensions --no-skills --model "${modelArg}" --system-prompt '@${systemPromptWin}' --tools ${[...tools].join(",")}`;

    script += `$prompt = @'\n${fullPrompt}\n'@\n\n`;
    script += `${piCmd} $prompt\n\n`;

    // Fallback: capture terminal if agent didn't save
    script += `if (-not (Test-Path "${resultFileWin}")) {\n`;
    script += `  $paneId = $env:WEZTERM_PANE\n`;
    script += `  if ($paneId) {\n`;
    script += `    $text = wezterm cli get-text --pane-id $paneId 2>$null\n`;
    script += `    if ($text) { $text | Out-File -FilePath "${resultFileWin}" -Encoding utf8 }\n`;
    script += `  }\n}\n\n`;

    script += `Remove-Item -Path "${scriptPath.replace(/\//g, "\\")}" -Force -ErrorAction SilentlyContinue\n`;
    script += `Remove-Item -Path "${systemPromptWin}" -Force -ErrorAction SilentlyContinue\n`;

    writeFileSync(scriptPath, script, "utf-8");
    tempFiles.add(scriptPath);
    scripts.push({ path: scriptPath, title: tabTitle });

    manifestAgents.push({
      name: dispatch.name,
      displayName: tabTitle,
      model: modelArg,
      prompt: dispatch.prompt,
      resultFile: resultFilePath,
    });
  }

  // Spawn panes
  let paneIds: string[] = [];
  try {
    if (layout === "grid" && agents.length > 1) {
      paneIds = await spawnGridLayout(agents.length, workingDir, scripts);
    } else {
      paneIds = await spawnTabLayout(workingDir, scripts);
    }

    // Map pane IDs back to manifest
    for (let i = 0; i < paneIds.length && i < manifestAgents.length; i++) {
      manifestAgents[i].paneId = paneIds[i];
    }

    for (let i = 0; i < manifestAgents.length; i++) {
      const a = manifestAgents[i];
      results.push(`[OK] ${a.displayName} | ${a.model} | pane:${a.paneId || "?"}`);
    }
  } catch (err: any) {
    results.push(`[ERROR] Layout spawn failed: ${err.message}`);
    results.push(`Falling back to tab layout...`);

    // Fallback to tabs
    try {
      paneIds = await spawnTabLayout(workingDir, scripts);
      for (let i = 0; i < paneIds.length && i < manifestAgents.length; i++) {
        manifestAgents[i].paneId = paneIds[i];
        results.push(`[OK] ${manifestAgents[i].displayName} | ${manifestAgents[i].model} | pane:${paneIds[i]}`);
      }
    } catch (err2: any) {
      results.push(`[FAIL] Tab fallback also failed: ${err2.message}`);
    }
  }

  // Save manifest
  const manifest: DispatchManifest = {
    taskId,
    taskSummary,
    dispatchedAt: new Date().toISOString(),
    workingDir,
    layout,
    agents: manifestAgents,
  };
  writeFileSync(join(taskDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2), "utf-8");

  // Start live status tracking
  activeDispatch = {
    taskId,
    manifest,
    completedAgents: new Set(),
    notifiedAgents: new Set(),
    allDoneNotified: false,
  };
  startPolling();

  results.push("");
  results.push(`Task ID: ${taskId}`);
  results.push(`Results dir: ${taskDir}`);
  results.push(`Status polling active — notifications will appear when agents finish.`);
  results.push(`User can say "collect", "/collect", or "/status" at any time.`);

  return { text: results.join("\n"), taskId };
}

// ════════════════════════════════════════════════════════════════
//  Extension entry point
// ════════════════════════════════════════════════════════════════

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();

  // ── System prompt ──

  pi.on("before_agent_start", async (event) => {
    event.system += `

# WezTerm Agent Dispatch System

You have tools to dispatch tasks to multiple agents running in separate WezTerm panes.
Each agent runs independently and saves results to a file. You can collect all results later.

## CRITICAL: Use wezterm_dispatch, NOT the Agent tool
\`wezterm_dispatch\` opens REAL WezTerm panes the user can see. The Agent tool runs hidden subagents.
When the user asks to dispatch/investigate/audit with multiple agents, always use \`wezterm_dispatch\`.

## Dispatch workflow:
1. Call \`list_dispatch_agents\` to see available agents
2. OR call \`list_dispatch_templates\` to see pre-configured templates
3. Select agents and craft specific prompts, OR use \`dispatch_from_template\`
4. Call \`wezterm_dispatch\` to open panes (grid layout by default)
5. Tell the user what you dispatched — they'll see panes appear in WezTerm

## Collecting results:
When user says "collect", "results", "trae los resultados", "/collect":
1. Call \`collect_dispatch_results\` to read all agent reports
2. Synthesize a unified report from all findings

## Status:
When user says "status", "/status", "como van":
- Report the current dispatch status (which agents done, which pending)

## Rules:
- Prompts must be self-contained — agents have NO context from this conversation
- Be specific: include file paths, tech stack, what to look for
- Don't dispatch if the task doesn't need multiple agents
`;
  });

  // ── Flush pending notifications on each turn ──

  pi.on("turn_start", async (_event, ctx) => {
    // Flush notifications
    for (const msg of pendingNotifications) {
      ctx.ui.notify(msg, "info");
    }
    pendingNotifications = [];

    // Update status widget
    if (activeDispatch && !activeDispatch.allDoneNotified) {
      ctx.ui.setWidget("dispatch-status", getStatusLines());
    } else if (activeDispatch?.allDoneNotified) {
      ctx.ui.setWidget("dispatch-status", [...getStatusLines(), "Ready to /collect"]);
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    for (const msg of pendingNotifications) {
      ctx.ui.notify(msg, "info");
    }
    pendingNotifications = [];

    if (activeDispatch) {
      // Refresh completion status before updating widget
      for (const agent of activeDispatch.manifest.agents) {
        if (!activeDispatch.completedAgents.has(agent.name) && existsSync(agent.resultFile)) {
          activeDispatch.completedAgents.add(agent.name);
        }
      }
      ctx.ui.setWidget("dispatch-status", getStatusLines());
    }
  });

  // ── Tool: list_dispatch_agents ──

  pi.registerTool({
    name: "list_dispatch_agents",
    description: "List all available agent definitions (custom + built-in). Call FIRST before dispatching.",
    parameters: Type.Object({}),
    async execute() {
      const custom = loadAllAgents(cwd);
      const builtins: AgentSummary[] = [
        { name: "general-purpose", display_name: "Agent", description: "General-purpose, all tools", model: "(current)", thinking: "off", max_turns: 10, tools: ["read", "bash", "edit", "write", "grep", "find", "ls"], prompt_mode: "append", source: "global", system_prompt_preview: "" },
        { name: "Explore", display_name: "Explore", description: "Fast read-only codebase exploration (Haiku)", model: "anthropic/claude-haiku-4-5-20251001", thinking: "off", max_turns: 10, tools: ["read", "bash", "grep", "find", "ls"], prompt_mode: "replace", source: "global", system_prompt_preview: "" },
        { name: "Plan", display_name: "Plan", description: "Architecture planning (read-only)", model: "(current)", thinking: "off", max_turns: 10, tools: ["read", "bash", "grep", "find", "ls"], prompt_mode: "replace", source: "global", system_prompt_preview: "" },
      ];
      const all = [...builtins, ...custom];
      const text = all.map((a) =>
        `- **${a.display_name}** (\`${a.name}\`) — ${a.description} | Model: ${a.model}, Thinking: ${a.thinking}`
      ).join("\n");
      return { content: [{ type: "text" as const, text: `# Agents (${all.length})\n\n${text}` }], details: { agents: all } };
    },
  });

  // ── Tool: list_dispatch_templates ──

  pi.registerTool({
    name: "list_dispatch_templates",
    description: "List pre-configured dispatch templates (audit, research, full-review, etc.). Templates define which agents to use and their prompts for common workflows.",
    parameters: Type.Object({}),
    async execute() {
      const templates = loadTemplates();
      if (templates.length === 0) {
        return { content: [{ type: "text" as const, text: "No dispatch templates found in " + TEMPLATES_DIR }], details: {} };
      }
      const text = templates.map((t) =>
        `### ${t.display_name} (\`${t.name}\`)\n- ${t.description}\n- Layout: ${t.layout}\n- Agents: ${t.agents.map((a) => a.name).join(", ")}\n`
      ).join("\n");
      return { content: [{ type: "text" as const, text: `# Dispatch Templates (${templates.length})\n\n${text}` }], details: { templates } };
    },
  });

  // ── Tool: dispatch_from_template ──

  pi.registerTool({
    name: "dispatch_from_template",
    description: `Dispatch agents using a pre-configured template. Templates define which agents to use and their prompt templates. Placeholders {working_dir} and {task} are replaced automatically.`,
    parameters: Type.Object({
      template_name: Type.String({ description: "Template name (e.g. 'audit', 'research', 'full-review')" }),
      task: Type.Optional(Type.String({ description: "Task description — replaces {task} in prompt templates" })),
      working_dir: Type.Optional(Type.String({ description: "Working directory — replaces {working_dir} in prompts. Defaults to cwd." })),
    }),
    async execute(_toolCallId, params) {
      const templates = loadTemplates();
      const template = templates.find((t) => t.name === params.template_name);
      if (!template) {
        const available = templates.map((t) => t.name).join(", ");
        return { content: [{ type: "text" as const, text: `Template "${params.template_name}" not found. Available: ${available}` }], details: {} };
      }

      const workDir = params.working_dir || cwd;
      const task = params.task || template.description;

      // Build agents with resolved prompts
      const agents: DispatchAgent[] = template.agents.map((a) => ({
        name: a.name,
        prompt: a.promptTemplate
          .replace(/\{working_dir\}/g, workDir)
          .replace(/\{task\}/g, task),
      }));

      const layout = template.layout === "tabs" ? "tabs" : "grid";
      const result = await executeDispatch(
        `[${template.display_name}] ${task}`,
        agents,
        layout as "grid" | "tabs",
        workDir,
        cwd
      );

      return {
        content: [{ type: "text" as const, text: result.text }],
        details: { taskId: result.taskId, template: template.name },
      };
    },
  });

  // ── Tool: wezterm_dispatch ──

  pi.registerTool({
    name: "wezterm_dispatch",
    description: `Dispatch agents to WezTerm panes. Default layout is "grid" (all agents visible at once). Use "tabs" for separate tabs.`,
    parameters: Type.Object({
      task_summary: Type.String({ description: "Brief summary of the overall task" }),
      layout: Type.Optional(Type.Union([Type.Literal("grid"), Type.Literal("tabs")], { description: "Layout mode. 'grid' shows all panes at once (default). 'tabs' opens separate tabs.", default: "grid" })),
      agents: Type.Array(
        Type.Object({
          name: Type.String({ description: "Agent name (from .md file or built-in)" }),
          prompt: Type.String({ description: "Specific task prompt for this agent" }),
          model_override: Type.Optional(Type.String({ description: "Override model" })),
          tab_title: Type.Optional(Type.String({ description: "Pane/tab title" })),
        }),
        { description: "Agents to dispatch" }
      ),
      working_dir: Type.Optional(Type.String({ description: "Working directory. Defaults to cwd." })),
    }),
    async execute(_toolCallId, params) {
      const layout = params.layout || "grid";
      const workDir = params.working_dir || cwd;

      const result = await executeDispatch(
        params.task_summary,
        params.agents,
        layout,
        workDir,
        cwd
      );

      return {
        content: [{ type: "text" as const, text: result.text }],
        details: { taskId: result.taskId },
      };
    },
  });

  // ── Tool: collect_dispatch_results ──

  pi.registerTool({
    name: "collect_dispatch_results",
    description: `Collect results from dispatched agents. Reads saved report files and optionally captures terminal output from running agents. If no task_id given, uses the most recent dispatch.`,
    parameters: Type.Object({
      task_id: Type.Optional(Type.String({ description: "Task ID. Omit for most recent." })),
      capture_running: Type.Optional(Type.Boolean({ description: "Capture terminal output from agents without saved results. Default: true." })),
    }),
    async execute(_toolCallId, params) {
      const taskId = params.task_id || getLatestTaskId();
      if (!taskId) return { content: [{ type: "text" as const, text: "No dispatches found." }], details: {} };

      const manifest = getManifest(taskId);
      if (!manifest) return { content: [{ type: "text" as const, text: `No manifest for task ${taskId}.` }], details: {} };

      const shouldCapture = params.capture_running !== false;
      const output: string[] = [];
      const agentResults: { name: string; status: string; content: string }[] = [];
      let completedCount = 0;

      output.push(`# Results — ${manifest.taskSummary}`);
      output.push(`Task: ${manifest.taskId} | ${manifest.dispatchedAt} | Layout: ${manifest.layout}\n`);

      for (const agent of manifest.agents) {
        output.push(`---`);
        output.push(`## ${agent.displayName} (\`${agent.name}\`) — ${agent.model}`);

        if (existsSync(agent.resultFile)) {
          const content = readFileSync(agent.resultFile, "utf-8");
          output.push(`Status: COMPLETED (${content.length} chars)\n`);
          output.push(content);
          agentResults.push({ name: agent.name, status: "completed", content });
          completedCount++;
        } else if (shouldCapture && agent.paneId) {
          try {
            const text = await runCommand("wezterm", ["cli", "get-text", "--pane-id", agent.paneId]);
            if (text.trim()) {
              output.push(`Status: IN PROGRESS (captured ${text.length} chars from terminal)\n`);
              output.push(text);
              agentResults.push({ name: agent.name, status: "in-progress", content: text });
            } else {
              output.push(`Status: PENDING\n`);
              agentResults.push({ name: agent.name, status: "pending", content: "" });
            }
          } catch {
            output.push(`Status: UNKNOWN (tab may be closed)\n`);
            agentResults.push({ name: agent.name, status: "unknown", content: "" });
          }
        } else {
          output.push(`Status: PENDING\n`);
          agentResults.push({ name: agent.name, status: "pending", content: "" });
        }
      }

      output.push(`\n---\n## Summary`);
      output.push(`Completed: ${completedCount}/${manifest.agents.length}`);
      if (completedCount === manifest.agents.length) {
        output.push(`\nAll agents done. Synthesize a unified report from the findings above.`);
      } else {
        output.push(`\nSome agents did not save a report. Terminal output was captured where possible.`);
      }
      // Always clear widget and stop polling on collect
      activeDispatch = null;
      stopPolling();

      return {
        content: [{ type: "text" as const, text: output.join("\n") }],
        details: { taskId, total: manifest.agents.length, completed: completedCount, results: agentResults },
      };
    },
  });

  // ── Command: /dispatch [template] ──

  pi.registerCommand("dispatch", { description: "Dispatch agents (optionally from a template)", handler: async (args, _ctx) => {
    const trimmed = (args || "").trim();

    if (trimmed) {
      pi.sendUserMessage(`Use dispatch_from_template with template "${trimmed}" in the current directory.`);
    } else {
      const templates = loadTemplates();
      const agents = loadAllAgents(cwd);
      const templateList = templates.map((t) => `  /dispatch ${t.name} — ${t.description}`).join("\n");
      const agentList = agents.map((a) => `  ${a.display_name} (${a.name})`).join("\n");

      pi.sendUserMessage([
        `Show me the available dispatch options. Here's what I have:`,
        ``,
        `Templates:\n${templateList || "  (none)"}`,
        ``,
        `Custom agents:\n${agentList || "  (none)"}`,
        ``,
        `I can use "/dispatch <template>" or describe a task for custom dispatch.`,
      ].join("\n"));
    }
  }});

  // ── Command: /collect ──

  pi.registerCommand("collect", { description: "Collect results from the last dispatch", handler: async (_args, _ctx) => {
    const taskId = getLatestTaskId();
    if (!taskId) {
      pi.sendUserMessage("No dispatch results found.");
      return;
    }
    pi.sendUserMessage(`Collect dispatch results from task ${taskId} and synthesize a unified report.`);
  }});

  // ── Command: /status ──

  pi.registerCommand("status", { description: "Show dispatch status", handler: async (_args, ctx) => {
    if (!activeDispatch) {
      const taskId = getLatestTaskId();
      if (taskId) {
        const manifest = getManifest(taskId);
        if (manifest) {
          activeDispatch = {
            taskId,
            manifest,
            completedAgents: new Set(
              manifest.agents.filter((a) => existsSync(a.resultFile)).map((a) => a.name)
            ),
            notifiedAgents: new Set(),
            allDoneNotified: false,
          };
        }
      }
    }

    if (!activeDispatch) {
      ctx.ui.notify("No active or recent dispatch.", "warning");
      return;
    }

    for (const agent of activeDispatch.manifest.agents) {
      if (!activeDispatch.completedAgents.has(agent.name) && existsSync(agent.resultFile)) {
        activeDispatch.completedAgents.add(agent.name);
      }
    }

    const lines = getStatusLines();
    ctx.ui.notify(lines.join("\n"), "info");
    ctx.ui.setWidget("dispatch-status", lines);
  }});

  process.on("exit", () => {
    for (const f of tempFiles) {
      try { unlinkSync(f); } catch {}
    }
  });
}
