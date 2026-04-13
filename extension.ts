/**
 * wezterm-dispatch — Dispatch tasks to multiple pi agents in WezTerm panes/tabs.
 *
 * Features:
 *   - Grid pane layout (see all agents working at once)
 *   - Live status widget + auto-notifications when agents finish
 *   - Dynamic agent matching: uses existing agents when they match, generates dynamic ones otherwise
 *   - Result collection back into the main session
 *
 * Tools:
 *   wezterm_dispatch          — Dispatch agents to WezTerm panes (dynamic matching)
 *   collect_dispatch_results  — Collect agent results
 *
 * Commands:
 *   /dispatch [task]  — Show available agents and dispatch
 *   /collect          — Collect results from last dispatch
 *   /status           — Show dispatch status
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { execFile } from "node:child_process";

// ════════════════════════════════════════════════════════════════
//  pi-subagents compatible agent config
// ════════════════════════════════════════════════════════════════

/**
 * Minimal AgentConfig — mirrors @tintinweb/pi-subagents structure but local
 * so this extension doesn't need to import from that package (which isn't
 * resolvable from the extensions directory).
 */
interface AgentConfig {
  name: string;
  displayName?: string;
  description: string;
  builtinToolNames?: string[];
  systemPrompt: string;
  model?: string;
  thinking?: string;
  maxTurns?: number;
  promptMode?: "replace" | "append";
  enabled?: boolean;
  source?: "default" | "project" | "global";
}

const READ_ONLY_TOOLS = ["read", "bash", "grep", "find", "ls"];

/**
 * Embedded default agents — mirrors pi-subagents/dist/default-agents.js
 * (general-purpose, Explore, Plan).
 */
const DEFAULT_AGENTS: Map<string, AgentConfig> = new Map([
  [
    "general-purpose",
    {
      name: "general-purpose",
      displayName: "Agent",
      description: "General-purpose agent for complex, multi-step tasks",
      systemPrompt: "",
      promptMode: "append" as const,
      source: "default" as const,
    },
  ],
  [
    "Explore",
    {
      name: "Explore",
      displayName: "Explore",
      description: "Fast codebase exploration agent (read-only)",
      builtinToolNames: READ_ONLY_TOOLS,
      systemPrompt: `# CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS
You are a file search specialist. You excel at thoroughly navigating and exploring codebases.
Your role is EXCLUSIVELY to search and analyze existing code. You do NOT have access to file editing tools.

You are STRICTLY PROHIBITED from:
- Creating new files
- Modifying existing files
- Deleting files
- Moving or copying files
- Creating temporary files anywhere
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state

Use Bash ONLY for read-only operations: ls, git status, git log, git diff, find, cat, head, tail.

# Output
- Use absolute file paths in all references
- Report findings as regular messages
- Do not use emojis
- Be thorough and precise`,
      promptMode: "replace" as const,
      source: "default" as const,
    },
  ],
  [
    "Plan",
    {
      name: "Plan",
      displayName: "Plan",
      description: "Software architect for implementation planning (read-only)",
      builtinToolNames: READ_ONLY_TOOLS,
      systemPrompt: `# CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS
You are a software architect and planning specialist.
Your role is EXCLUSIVELY to explore the codebase and design implementation plans.
You do NOT have access to file editing tools.

# Planning Process
1. Understand requirements
2. Explore thoroughly (read files, find patterns, understand architecture)
3. Design solution based on your assigned perspective
4. Detail the plan with step-by-step implementation strategy

# Output Format
- Use absolute file paths
- Do not use emojis
- End with "### Critical Files for Implementation" listing 3-5 key files`,
      promptMode: "replace" as const,
      source: "default" as const,
    },
  ],
]);

/**
 * Parse YAML-ish frontmatter from an agent .md file.
 */
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

/**
 * Load custom agents from the same locations pi-subagents reads:
 *   1. Project: <cwd>/.pi/agents/*.md
 *   2. Global:  ~/.pi/agent/agents/*.md
 * Project-level overrides global.
 */
function loadCustomAgents(cwd: string): Map<string, AgentConfig> {
  const agents = new Map<string, AgentConfig>();
  const dirs: Array<{ path: string; source: "global" | "project" }> = [
    { path: join(homedir(), ".pi", "agent", "agents"), source: "global" },
    { path: join(cwd, ".pi", "agents"), source: "project" },
  ];

  for (const { path: dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const file of files) {
      const name = basename(file, ".md");
      let content: string;
      try {
        content = readFileSync(join(dir, file), "utf-8");
      } catch {
        continue;
      }
      const { frontmatter: fm, body } = parseFrontmatter(content);
      const tools = fm.tools ? fm.tools.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
      agents.set(name, {
        name,
        displayName: fm.display_name || name,
        description: fm.description || name,
        builtinToolNames: tools,
        systemPrompt: body.trim(),
        thinking: fm.thinking,
        maxTurns: fm.max_turns ? parseInt(fm.max_turns, 10) : undefined,
        promptMode: fm.prompt_mode === "append" ? "append" : "replace",
        enabled: fm.enabled !== "false",
        source,
      });
    }
  }
  return agents;
}

// ════════════════════════════════════════════════════════════════
//  Constants
// ════════════════════════════════════════════════════════════════

const RESULTS_BASE_DIR = join(homedir(), ".pi", "dispatch-results");
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

/**
 * Convert a pi-subagents AgentConfig into our AgentSummary format.
 */
function configToSummary(cfg: AgentConfig): AgentSummary {
  const body = cfg.systemPrompt || "";
  return {
    name: cfg.name,
    display_name: cfg.displayName || cfg.name,
    description: cfg.description || "",
    model: cfg.model || "(current)",
    thinking: cfg.thinking || "off",
    max_turns: cfg.maxTurns || 10,
    tools: cfg.builtinToolNames || ["read", "bash", "grep", "find", "ls"],
    prompt_mode: cfg.promptMode || "append",
    source: cfg.source === "project" ? "project" : "global",
    system_prompt_preview: body.slice(0, 200) + (body.length > 200 ? "..." : ""),
  };
}

/**
 * Load all agents available to pi-subagents:
 *   - Embedded defaults (general-purpose, Explore, Plan)
 *   - Custom agents from ~/.pi/agent/agents/*.md and <cwd>/.pi/agents/*.md
 */
function loadAllAgents(cwd: string): AgentSummary[] {
  const agents = new Map<string, AgentConfig>();

  // 1. Embedded defaults
  for (const [name, cfg] of DEFAULT_AGENTS.entries()) {
    agents.set(name, cfg);
  }

  // 2. Custom agents (override defaults if same name)
  const custom = loadCustomAgents(cwd);
  for (const [name, cfg] of custom.entries()) {
    if (cfg.enabled === false) continue;
    agents.set(name, cfg);
  }

  return [...agents.values()].map(configToSummary);
}

/**
 * Get the raw AgentConfig for a specific agent by name (for system prompt extraction).
 */
function getAgentConfig(cwd: string, name: string): AgentConfig | undefined {
  const custom = loadCustomAgents(cwd);
  return custom.get(name) || DEFAULT_AGENTS.get(name);
}

// ════════════════════════════════════════════════════════════════
//  Model discovery (GPT-only)
// ════════════════════════════════════════════════════════════════

/**
 * Read enabled models from ~/.pi/agent/settings.json and filter to GPT only.
 * (Claude models don't work in this pi setup — user has no Anthropic API key.)
 */
function getAvailableGptModels(): { enabled: string[]; defaultModel?: string; defaultThinking?: string } {
  const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
  if (!existsSync(settingsPath)) return { enabled: [] };
  try {
    const raw = readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(raw) as {
      enabledModels?: string[];
      defaultModel?: string;
      defaultProvider?: string;
      defaultThinkingLevel?: string;
    };
    const enabled = (settings.enabledModels || []).filter(
      (m) => m.toLowerCase().includes("gpt") || m.toLowerCase().includes("openai")
    );
    return {
      enabled,
      defaultModel: settings.defaultModel,
      defaultThinking: settings.defaultThinkingLevel,
    };
  } catch {
    return { enabled: [] };
  }
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
  name?: string;        // Agent name (uses preprompt from .md file if exists)
  prompt?: string;      // Custom prompt (used for dynamically generated agents)
  model_override?: string;
  tab_title?: string;
}

async function executeDispatch(
  taskSummary: string,
  task: string,
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

  for (let i = 0; i < agents.length; i++) {
    const dispatch = agents[i];

    // Generate unique name for dynamic agents without a name
    const agentName = dispatch.name || `dynamic-${i + 1}`;
    const agentCfg = dispatch.name ? getAgentConfig(cwd, dispatch.name) : undefined;
    const agentSummary = dispatch.name ? agentMap.get(dispatch.name) : undefined;

    const thinking = agentCfg?.thinking || "off";
    const tabTitle = dispatch.tab_title || agentCfg?.displayName || agentName;

    // Result file
    const resultFilePath = join(taskDir, `${agentName}.md`);
    const resultFileWin = resultFilePath.replace(/\//g, "\\");

    // Get system prompt body directly from AgentConfig (already parsed by pi-subagents)
    const agentSystemPrompt = agentCfg?.systemPrompt?.trim() || "";

    // Determine the role content:
    // - If agent has preprompt from pi-subagents, use that
    // - If agent has custom prompt, use that
    // - Otherwise use generic analyst role
    let roleContent = "";
    if (agentSystemPrompt) {
      roleContent = agentSystemPrompt;
    } else if (dispatch.prompt) {
      roleContent = dispatch.prompt;
    } else {
      roleContent = "You are a thorough analyst. Do your work directly using the tools above.";
    }

    // Build a COMPLETE system prompt that replaces pi's default.
    // This is critical: --system-prompt replaces the default prompt so the model
    // doesn't know about Agent, sub-agents, or any dispatch tools.
    // Combined with --no-extensions, the Agent tool won't even exist.
    const workingDirWin = workingDir.replace(/\//g, "\\");
    const systemPromptContent = [
      "You are an autonomous code investigation agent running in an isolated subprocess.",
      "You work DIRECTLY on files using your tools. You are NOT a chat assistant.",
      "",
      "# ABSOLUTELY CRITICAL - READ THIS FIRST",
      "",
      "You have DIRECT FILESYSTEM ACCESS via your tools. The user is NOT present in this session.",
      "There is NO ONE to answer your questions. Asking for files, pasting code, or 'sharing the repo'",
      "is IMPOSSIBLE — those messages will be IGNORED and your work will be LOST.",
      "",
      "The project you must investigate is ALREADY on disk at:",
      `  ${workingDirWin}`,
      "",
      "You must use your tools to EXPLORE AND READ that directory yourself. No one will paste code to you.",
      "",
      "# STRICTLY PROHIBITED",
      "",
      "- DO NOT say 'share the repo', 'paste the file', 'send me the code', 'I need you to provide...'",
      "- DO NOT ask clarifying questions — there is NO user to answer them",
      "- DO NOT describe what you WOULD do — actually DO it with your tools",
      "- DO NOT wait for approval — work autonomously until you have findings or hit a dead end",
      "- DO NOT produce hypothetical evidence — only report what you ACTUALLY see in the real files",
      "",
      "# Your tools (use them directly)",
      "- **ls** — List directory contents (START HERE to see project layout)",
      "- **read** — Read file contents",
      "- **grep** — Search file contents with regex (use for finding patterns across files)",
      "- **find** — Find files by name pattern",
      "- **bash** — Execute read-only shell commands (git log, git diff, cat, head, tail)",
      "- **write** — Create or overwrite files (use this to SAVE YOUR REPORT)",
      "- **edit** — Edit existing files with find-and-replace (rarely needed for investigation)",
      "",
      "# Required workflow",
      "",
      "1. **Orient yourself**: Start with `ls` on the working directory to see the project structure",
      "2. **Explore**: Use `grep`/`find` to locate files relevant to your task",
      "3. **Read**: Use `read` on the relevant files to understand the code",
      "4. **Analyze**: Build your findings from what you actually see in the code",
      "5. **Save**: Use `write` to save your complete report (see below)",
      "",
      "# Your role",
      roleContent,
      "",
      "# Output rules",
      "- Base ALL findings on real file content you read with your tools — NEVER on hypotheticals",
      "- Use absolute file paths in all references",
      "- Include line numbers when citing code",
      "- Quote exact code snippets from the files you read",
      "- Be thorough and precise",
      "- Do not use emojis",
      "",
      "# SAVE YOUR REPORT (mandatory)",
      "",
      "Your work is ONLY considered done if you save a report. Partial findings are better than nothing.",
      "Even if you hit a dead end, save what you found.",
      "",
      "When you finish, you MUST save your complete report using the `write` tool to:",
      `  ${resultFileWin}`,
      "",
      "Format as comprehensive markdown with:",
      "- Title",
      "- Executive summary (2-3 sentences)",
      "- Findings organized by section",
      "- File paths and line numbers for each finding",
      "- Code snippets quoted from actual files",
      "- Conclusions and next steps",
      "",
      "YOUR WORK IS LOST if you don't save. Save even if your findings are incomplete.",
    ].join("\n");

    // Write system prompt to temp file (UTF-8, no BOM — pi reads it as UTF-8)
    const scriptId = `dispatch_${agentName}_${Date.now()}`;
    const systemPromptPath = join(homedir(), ".pi", "agent", `${scriptId}_system.txt`);
    writeFileSync(systemPromptPath, systemPromptContent, "utf-8");
    tempFiles.add(systemPromptPath);

    // Write the user prompt to a separate UTF-8 file — avoids PowerShell
    // heredoc encoding issues (PS5 reads .ps1 as CP1252 by default, corrupting
    // non-ASCII chars like é/ñ/á).
    const promptPath = join(homedir(), ".pi", "agent", `${scriptId}_prompt.txt`);
    writeFileSync(promptPath, task, "utf-8");
    tempFiles.add(promptPath);

    // Build PowerShell script
    const scriptPath = join(homedir(), ".pi", "agent", `${scriptId}.ps1`);

    const systemPromptWin = systemPromptPath.replace(/\//g, "\\");
    const promptWin = promptPath.replace(/\//g, "\\");

    const tools = new Set(agentSummary?.tools?.length ? agentSummary.tools : ["read", "bash", "grep", "find", "ls"]);
    tools.add("write");
    tools.add("bash");

    let modelFlag = "";
    if (dispatch.model_override) {
      const modelArg = thinking !== "off" ? `${dispatch.model_override}:${thinking}` : dispatch.model_override;
      modelFlag = ` --model "${modelArg}"`;
    } else if (thinking !== "off") {
      // Apply thinking level to default model via env-free flag
      modelFlag = ` --thinking "${thinking}"`;
    }

    // Note on --no-extensions / --no-skills / --system-prompt / --tools:
    //   These replace pi's default behavior so the subagent runs in isolation
    //   (no Agent tool, no skills, custom system prompt, explicit tool list).
    // Note on --model: only passed if explicitly overridden — otherwise pi uses
    //   the user's default model from settings.json.
    // IMPORTANT: --tools value MUST be quoted. Without quotes, PowerShell
    // interprets "read,bash,grep,..." as an array literal and passes it
    // space-separated to pi, producing: --tools "read bash grep ..." which
    // pi rejects with "Unknown tool ...".
    const toolsArg = [...tools].join(",");
    const piCmd = `pi --no-extensions --no-skills${modelFlag} --system-prompt '@${systemPromptWin}' --tools "${toolsArg}"`;

    // Build the script. We use CRLF line endings for maximum PS5 compatibility.
    //
    // CRITICAL: We do NOT read the prompt into a PowerShell variable and pass
    // it as an argument. pi uses `[@files...] [messages...]` as its argument
    // format, and Windows' CommandLineToArgvW splits arguments on whitespace
    // (including \r\n). A multi-line prompt passed as a variable gets split
    // into multiple "message" arguments, which pi then processes as sequential
    // messages in interactive mode — causing the "buffer bug" where the agent
    // received fragments like "Image", "at", "22.45.26.jpeg" as new messages.
    //
    // Instead, we pass the prompt via pi's `@file` syntax: `pi ... @prompt.txt`
    // tells pi to read the file contents and use them as the initial message.
    // Newlines inside the file are preserved because they never pass through
    // the Windows command-line parser.
    const lines: string[] = [
      // Force UTF-8 for all I/O in this process — fixes mojibake for non-ASCII
      // characters when passing to pi CLI.
      `chcp 65001 > $null`,
      `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`,
      `[Console]::InputEncoding = [System.Text.Encoding]::UTF8`,
      `$OutputEncoding = [System.Text.Encoding]::UTF8`,
      ``,
      `$Host.UI.RawUI.WindowTitle = '${tabTitle.replace(/'/g, "''")}'`,
      `$ErrorActionPreference = 'Continue'`,
      ``,
      // Pass the prompt as a file attachment using pi's @file syntax.
      // pi reads the file directly — no Windows argument splitting.
      `${piCmd} '@${promptWin}'`,
      ``,
      // Fallback: capture terminal if agent didn't save
      `if (-not (Test-Path "${resultFileWin}")) {`,
      `  $paneId = $env:WEZTERM_PANE`,
      `  if ($paneId) {`,
      `    $text = wezterm cli get-text --pane-id $paneId 2>$null`,
      `    if ($text) { $text | Out-File -FilePath "${resultFileWin}" -Encoding utf8 }`,
      `  }`,
      `}`,
      ``,
      `Remove-Item -Path "${scriptPath.replace(/\//g, "\\")}" -Force -ErrorAction SilentlyContinue`,
      `Remove-Item -Path "${systemPromptWin}" -Force -ErrorAction SilentlyContinue`,
      `Remove-Item -Path "${promptWin}" -Force -ErrorAction SilentlyContinue`,
      ``,
    ];
    const script = lines.join("\r\n");

    // Write script with UTF-8 BOM so PowerShell 5 detects UTF-8 encoding
    // (without BOM, PS5 on Windows defaults to CP1252 when reading scripts).
    const BOM = "\uFEFF";
    writeFileSync(scriptPath, BOM + script, "utf-8");
    tempFiles.add(scriptPath);
    scripts.push({ path: scriptPath, title: tabTitle });

    const displayModel = dispatch.model_override || "(pi default)";
    manifestAgents.push({
      name: agentName,
      displayName: tabTitle,
      model: thinking !== "off" ? `${displayModel}:${thinking}` : displayModel,
      prompt: task,
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
    // Read available GPT models from pi settings
    const { enabled: availableModels, defaultModel, defaultThinking } = getAvailableGptModels();
    const modelsList = availableModels.length > 0
      ? availableModels.map((m) => `  - \`${m}\``).join("\n")
      : "  (none configured — wezterm_dispatch will use pi's default)";
    const defaultLine = defaultModel
      ? `Current pi default: \`${defaultModel}\`${defaultThinking ? ` (thinking: ${defaultThinking})` : ""}`
      : "";

    event.system += `

# WezTerm Agent Dispatch System

You have tools to dispatch tasks to multiple agents running in separate WezTerm panes.
Each agent runs independently and saves results to a file. You can collect all results later.

## ABSOLUTELY CRITICAL — DO NOT USE THE Agent TOOL

**Under NO circumstances may you call the \`Agent\`, \`get_subagent_result\`, or \`steer_subagent\` tools from pi-subagents.**
Those tools run hidden background subagents that the user CANNOT see. They are BLOCKED in this session.
Calls to them will be intercepted and rejected.

When the user asks to dispatch/investigate/audit/analyze with multiple agents, **the ONLY valid tool is \`wezterm_dispatch\`**.
\`wezterm_dispatch\` opens real WezTerm panes visible to the user. This is ALWAYS what the user wants.

### Never do this:
\`\`\`
Agent({ subagent_type: "Explore", prompt: "..." })          // FORBIDDEN
Agent({ subagent_type: "general-purpose", prompt: "..." }) // FORBIDDEN
\`\`\`

### Always do this instead:
\`\`\`
wezterm_dispatch({
  task_summary: "...",
  task: "...",
  agents: [{ name: "code-analyst" }, { prompt: "..." }]
})
\`\`\`

## Available GPT models (the ONLY models you can use in model_override):
${modelsList}
${defaultLine}

IMPORTANT: Only use models from the list above. Never use Anthropic/Claude models — they are not configured.
If you need to override the model for an agent, pass \`model_override\` with one of the values above.
If you don't pass \`model_override\`, the agent uses pi's current default.

## Model selection guide (GPT family):
- **gpt-5.4-mini** (or any \`*-mini\`) — Fast, cheap. Best for:
  - File exploration, codebase navigation
  - Simple pattern search
  - Running tests, reading logs
  - Tasks that don't need deep reasoning
- **gpt-5.4** (full model) — More capable, slower. Best for:
  - Code analysis, architecture review
  - Bug detection and root-cause analysis
  - Security auditing (edge cases matter)
  - Refactoring and complex reasoning
  - Anything where quality > speed

## Thinking levels (applied via \`thinking\` field in agent .md or model_override suffix):
- \`off\` / \`minimal\` — Fastest, for straightforward tasks
- \`low\` — Slight reasoning boost, good for code analysis
- \`medium\` — Balanced, good default for analysis/planning
- \`high\` / \`xhigh\` — Deepest reasoning, use for tricky bugs, security audits, complex refactors

## Dynamic dispatch workflow:
1. When the user invokes /dispatch, the list of available agents is provided in the message — DO NOT call any listing tool, just use what's there
2. When user requests N agents for a task:
   - Match user's request to existing agents (use their \`name\` for preprompt)
   - Generate dynamic agents with custom \`prompt\` for what's missing
   - For each agent, pick the right model via \`model_override\` based on its role:
     * Explorers/searchers → mini
     * Analysts/auditors → full gpt-5.4
   - Set the \`task\` parameter to what ALL agents will work on
3. Call \`wezterm_dispatch\` directly to open panes (grid layout by default)
4. Tell the user what you dispatched (including which model for each) — they'll see panes appear in WezTerm

## Collecting results:
When user says "collect", "results", "trae los resultados", "/collect":
1. Call \`collect_dispatch_results\` to read all agent reports
2. Synthesize a unified report from all findings

## Status:
When user says "status", "/status", "como van":
- Report the current dispatch status (which agents done, which pending)

## Rules:
- The \`task\` must be self-contained — agents have NO context from this conversation
- Be specific in the task: include file paths, tech stack, what to look for
- Don't dispatch if the task doesn't need multiple agents
- Prefer using existing agents when they match the user's request
- NEVER use Anthropic/Claude models in \`model_override\` — only the GPT models listed above
`;
  });

  // ── Block pi-subagents tools (Agent, get_subagent_result, steer_subagent) ──
  //    Force the LLM to use wezterm_dispatch instead of hidden background subagents.

  const BLOCKED_TOOLS = new Set(["Agent", "get_subagent_result", "steer_subagent"]);

  pi.on("tool_call", async (event) => {
    if (event.toolName && BLOCKED_TOOLS.has(event.toolName)) {
      return {
        block: true,
        reason: `The \`${event.toolName}\` tool is disabled in this session. Use \`wezterm_dispatch\` instead — it opens visible WezTerm panes the user can watch. Re-dispatch your agents using wezterm_dispatch with the same task.`,
      };
    }
    return undefined;
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
    } else {
      // activeDispatch was cleared (e.g. by /collect) — remove the widget
      ctx.ui.setWidget("dispatch-status", undefined);
    }
  });


  // ── Tool: wezterm_dispatch ──

  pi.registerTool({
    name: "wezterm_dispatch",
    description: `Dispatch agents to WezTerm panes dynamically.

For each agent, you can either:
- Specify a 'name' to use an existing agent's preprompt (from ~/.pi/agent/agents/*.md)
- Specify a 'prompt' for a dynamically generated agent
- Specify both 'name' AND 'prompt' to use the agent's preprompt plus a custom context

The 'task' is the specific task ALL agents will work on (appended to their system prompt).`,
    parameters: Type.Object({
      task_summary: Type.String({ description: "Brief summary of the overall task (for display)" }),
      task: Type.String({ description: "The specific task all agents will work on. This is sent as the user prompt to each agent." }),
      layout: Type.Optional(Type.Union([Type.Literal("grid"), Type.Literal("tabs")], { description: "Layout mode. 'grid' shows all panes at once (default). 'tabs' opens separate tabs.", default: "grid" })),
      agents: Type.Array(
        Type.Object({
          name: Type.Optional(Type.String({ description: "Agent name (from .md file). Uses the agent's preprompt as role context." })),
          prompt: Type.Optional(Type.String({ description: "Custom prompt for dynamically generated agents, or additional context for named agents." })),
          model_override: Type.Optional(Type.String({ description: "Override model for this agent" })),
          tab_title: Type.Optional(Type.String({ description: "Pane/tab title" })),
        }),
        { description: "Agents to dispatch. Each agent needs at least 'name' or 'prompt'." }
      ),
      working_dir: Type.Optional(Type.String({ description: "Working directory. Defaults to cwd." })),
    }),
    async execute(_toolCallId, params) {
      const layout = params.layout || "grid";
      const workDir = params.working_dir || cwd;

      // Validate: each agent needs at least name or prompt
      for (const agent of params.agents) {
        if (!agent.name && !agent.prompt) {
          return {
            content: [{ type: "text" as const, text: "Error: Each agent must have at least 'name' or 'prompt'" }],
            details: {},
          };
        }
      }

      const result = await executeDispatch(
        params.task_summary,
        params.task,
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

  // ── Command: /dispatch ──

  pi.registerCommand("dispatch", { description: "Show available agents and start a dispatch", handler: async (args, _ctx) => {
    const trimmed = (args || "").trim();
    const agents = loadAllAgents(cwd);
    const agentList = agents.map((a) => `  - **${a.display_name}** (\`${a.name}\`) — ${a.description}`).join("\n");

    if (trimmed) {
      // User provided a task description directly
      pi.sendUserMessage([
        `Dispatch agents for: "${trimmed}"`,
        ``,
        `Available agents that might match:`,
        agentList || "  (none)",
        ``,
        `Decide which agents fit this task, how many to use, and dispatch them.`,
      ].join("\n"));
    } else {
      pi.sendUserMessage([
        `Show me the available agents for dispatch:`,
        ``,
        agentList || "  (none)",
        ``,
        `Tell me what task you want to accomplish and how many agents to use.`,
        `I'll match your request to the best agents and create dynamic ones if needed.`,
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
