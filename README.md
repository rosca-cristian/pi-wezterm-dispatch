# pi-wezterm-dispatch

A [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) extension that dispatches tasks to multiple specialist agents, each running in its own **WezTerm pane**. See all agents working simultaneously in a grid layout, then collect their results back into your main session for synthesis.

> **Windows-only.** Uses PowerShell scripts and Windows-native paths. Linux/macOS support is not currently planned.

---

## What it does

You describe a task. The extension:

1. **Matches** your request against available specialist agents (code-analyst, security-auditor, tester, etc.)
2. **Generates dynamic agents** on the fly for aspects of the task that don't map to an existing agent
3. **Opens a WezTerm grid** with one pane per agent, each running an independent `pi` session
4. **Tracks status live** — notifications pop up as each agent finishes
5. **Collects results** on demand — bringing all reports back into the main session for a unified synthesis

### Example

```
You: Lanza 3 agentes para auditar la seguridad del módulo auth
```

The LLM matches `security-auditor` to your request, generates 2 more dynamic agents
to cover dependency scanning and API endpoint review, then opens:

```
┌──────────────────────────┬──────────────────────────┐
│   Security Auditor       │   Dependency Scanner     │
│   (gpt-5.4 high)         │   (gpt-5.4-mini)         │
│                          │                          │
│   Auditing auth/...      │   Checking CVEs...       │
├──────────────────────────┼──────────────────────────┤
│   API Endpoint Review    │                          │
│   (gpt-5.4)              │                          │
│                          │                          │
│   Tracing routes...      │                          │
└──────────────────────────┴──────────────────────────┘
```

When they finish, say `/collect` and the main agent merges all reports into a single unified analysis.

---

## Features

- **Dynamic agent matching** — no rigid templates; the LLM picks existing agents when they fit and generates new ones for the rest
- **Preprompt + task composition** — existing agents contribute their specialist system prompt, and the task you describe is appended on top
- **Grid pane layout** — see all agents working at once (auto-calculated from agent count)
- **Live status widget** — the pi footer shows which agents are running/done
- **Auto-notifications** — popups when individual agents finish
- **Result collection** — merges reports from all dispatched agents into your main session
- **Terminal capture fallback** — if an agent forgets to save its report, captures the pane's output automatically
- **GPT-only model selection** — reads your `settings.json` `enabledModels` and filters to GPT family (Anthropic models excluded because they require a separate API key)
- **Automatic model picking by role** — the LLM picks `gpt-5.4` for analysis/audit work and `gpt-5.4-mini` for exploration/search tasks
- **Agent tool blocking** — the hidden `Agent` / `get_subagent_result` / `steer_subagent` tools from pi-subagents are intercepted so the LLM is forced to use `wezterm_dispatch` (visible panes) instead of hidden subagents
- **Isolated agents** — each dispatched agent runs with `--no-extensions --no-skills` and a clean system prompt that blocks delegation loops
- **UTF-8 / accent safe** — scripts are written with UTF-8 BOM and the prompt is passed via pi's `@file` syntax to avoid Windows command-line encoding issues and argument splitting bugs

---

## Requirements

| Requirement | Notes |
|---|---|
| **Windows 10/11** | PowerShell-based scripts, Windows paths |
| **[pi-coding-agent](https://www.npmjs.com/package/@mariozechner/pi-coding-agent)** `>= 0.65.0` | The host framework |
| **[WezTerm](https://wezfurlong.org/wezterm/)** with CLI in PATH | Required for `wezterm cli spawn`, `split-pane`, `get-text` |
| **OpenAI / compatible GPT API key** | The extension assumes GPT models. Anthropic models are filtered out. |

Verify your setup:

```powershell
pi --version
wezterm cli --help
```

---

## Installation

### Option A — Via pi install (recommended)

```powershell
pi install git:github.com/rosca-cristian/pi-wezterm-dispatch
```

This registers the extension in your pi `settings.json`. The extension auto-discovers on next pi startup.

### Option B — Manual install

1. Clone this repo:

   ```powershell
   git clone https://github.com/rosca-cristian/pi-wezterm-dispatch.git
   cd pi-wezterm-dispatch
   ```

2. Copy the files to your pi global directories:

   ```powershell
   # Extension file
   mkdir -Force $HOME\.pi\agent\extensions
   Copy-Item extension.ts $HOME\.pi\agent\extensions\wezterm-dispatch.ts

   # Example agents (optional)
   mkdir -Force $HOME\.pi\agent\agents
   Copy-Item agents\*.md $HOME\.pi\agent\agents\
   ```

3. Launch `pi` — the extension loads automatically from `~/.pi/agent/extensions/`.

---

## Directory layout after install

```
~/.pi/agent/
├── extensions/
│   └── wezterm-dispatch.ts        ← this extension
├── agents/                         ← specialist agent definitions (.md)
│   ├── researcher.md
│   ├── code-analyst.md
│   ├── implementer.md
│   ├── security-auditor.md
│   └── tester.md
└── dispatch-results/               ← auto-created at dispatch time
    └── <task-id>/
        ├── manifest.json
        ├── <agent-name>.md         ← each agent's saved report
        └── ...
```

The extension also recognizes the three built-in pi-subagents defaults (`general-purpose`, `Explore`, `Plan`) without any configuration.

---

## Usage

### 1. Quick command

```
/dispatch
```

Lists available agents and asks you to describe the task.

```
/dispatch Review the authentication flow for race conditions
```

Hands the task description to the LLM, which picks the right agents and dispatches them.

### 2. Natural language

Just ask:

```
Lanza 4 agentes para investigar por qué la clasificación de documentos genera jerarquías raras
```

The LLM will:
1. Look at the available agents provided by `/dispatch`
2. Match existing agents to the request (e.g. `code-analyst`, `tester`)
3. Generate dynamic agents for the rest
4. Pick the right GPT model for each (analysis → `gpt-5.4`, exploration → `gpt-5.4-mini`)
5. Open WezTerm panes and start them

### 3. Monitor progress

```
/status
```

Shows which agents are running and which have finished. Notifications appear automatically in the main session as agents complete.

### 4. Collect results

When you're ready (or when `/status` shows all agents done):

```
/collect
```

Or just say *"trae los resultados"* / *"collect the results"*. The main agent reads every report and synthesizes a unified response highlighting agreements, disagreements, and key insights.

---

## Commands

| Command | Description |
|---|---|
| `/dispatch` | Show available agents |
| `/dispatch <task>` | Dispatch agents for a described task |
| `/status` | Show current dispatch status |
| `/collect` | Collect and synthesize results from the latest dispatch |

## Tools (for the LLM)

| Tool | Purpose |
|---|---|
| `wezterm_dispatch` | Open WezTerm panes with agents + task prompts (dynamic matching) |
| `collect_dispatch_results` | Read and return all agent reports |

### The `wezterm_dispatch` tool

```ts
wezterm_dispatch({
  task_summary: "Investigate classification nesting bug",
  task: "Find why document classification produces nonsensical nested folders. Start in src/services/",
  layout: "grid",   // or "tabs"
  agents: [
    { name: "code-analyst" },                              // uses existing preprompt + task
    { name: "tester", model_override: "openai-codex/gpt-5.4" },
    { prompt: "You are a dependency-graph explorer..." }, // dynamic agent with custom role
  ],
})
```

- `name` — use an existing agent's preprompt (from `~/.pi/agent/agents/*.md` or pi-subagents defaults)
- `prompt` — generate a dynamic agent with a custom role description
- Both `name` and `prompt` can be combined: the agent's preprompt is used as the role, and the custom prompt is appended
- `task` is sent as the user message to every agent — it's the specific work they need to do
- `model_override` is optional; when omitted, agents use pi's current default model

---

## Creating custom agents

Drop a markdown file into `~/.pi/agent/agents/<name>.md`:

```markdown
---
name: db-migrator
display_name: Database Migration Agent
description: Plans and executes schema migrations safely
thinking: high
max_turns: 20
tools: read,bash,edit,write,grep,find,ls
enabled: true
prompt_mode: replace
---

# Database Migration Specialist

You are an expert at designing and executing database schema migrations...

## Rules
- Always check for active connections before altering tables
- Write reversible migrations when possible
- Test on a copy before production
```

The file is auto-discovered next time you launch `pi`.

### Frontmatter fields

| Field | Description |
|---|---|
| `name` | Internal name (must be unique) |
| `display_name` | Label shown in the UI and tab titles |
| `description` | What this agent is good at (helps the LLM select it) |
| `thinking` | `off`, `low`, `medium`, `high`, `xhigh` |
| `max_turns` | Max agent loop turns |
| `tools` | Comma-separated: `read,bash,grep,find,ls,write,edit` |
| `enabled` | `true`/`false` |
| `prompt_mode` | `replace` or `append` (replace is safer for dispatch) |

> **Note on `model`:** This extension intentionally ignores any `model` field in agent `.md` files. The model is always decided by the LLM at dispatch time (from the GPT models in your `settings.json`). This prevents failures when an agent's pinned model isn't configured in your environment.

---

## Model selection

The extension reads `~/.pi/agent/settings.json` and injects the GPT-family models from `enabledModels` into the LLM's system prompt, along with a selection guide:

- `gpt-5.4-mini` — fast, cheap, good for exploration and search
- `gpt-5.4` — full model, best for analysis, audits, bug detection

Thinking levels are also documented in the system prompt:

- `off` / `minimal` — fastest
- `low` — slight reasoning boost
- `medium` — balanced default
- `high` / `xhigh` — deepest reasoning, for tricky bugs or security audits

The LLM decides which model and thinking level to pair with each agent based on its role.

---

## How it works (technical)

1. **Spawn phase** — for each dispatched agent, the extension:
   - Writes a temporary PowerShell script with UTF-8 BOM to `~/.pi/agent/dispatch_<agent>_<timestamp>.ps1`
   - Writes a clean system prompt file to `~/.pi/agent/dispatch_<agent>_<timestamp>_system.txt`
   - Writes the task description to `~/.pi/agent/dispatch_<agent>_<timestamp>_prompt.txt`
   - Calls `wezterm cli spawn` (first pane) or `wezterm cli split-pane` (subsequent panes) to create the grid
   - Each pane runs: `pi --no-extensions --no-skills [--thinking <lvl>] --system-prompt '@<system-file>' --tools "<tools>" '@<prompt-file>'`

2. **Why `--no-extensions`?** To remove the `Agent` tool from the dispatched agent's environment — otherwise it would try to spawn its own sub-agents, creating an infinite delegation loop. The dispatched agent only has core pi tools (`read`, `bash`, `grep`, `find`, `ls`, `write`, `edit`).

3. **Why `--system-prompt` (not `--append`)?** A full replace strips pi's default system prompt that mentions sub-agent delegation. The agent only sees our clean, specialist-focused prompt.

4. **Why the prompt is passed as `'@file'` and not as an argument?** Windows' `CommandLineToArgvW` splits arguments on whitespace — including `\r\n`. A multi-line prompt passed as a variable gets split into multiple "message" arguments, which pi then processes as sequential interactive messages (the infamous "buffer bug"). Using `'@file'` makes pi read the file directly, bypassing the Windows command-line parser entirely.

5. **Why UTF-8 BOM?** PowerShell 5 on Windows reads `.ps1` scripts as CP1252 by default. Non-ASCII characters like `é`, `ñ`, `á` become mojibake (`Ã©`, `Ã±`, `Ã¡`) when passed to pi. Writing scripts with a UTF-8 BOM makes PS5 detect the encoding correctly. We also force `chcp 65001` at the start of each script as a belt-and-braces measure.

6. **Agent tool blocking** — the extension registers a `tool_call` hook that intercepts calls to pi-subagents' hidden tools (`Agent`, `get_subagent_result`, `steer_subagent`) and returns `{ block: true }` with a message redirecting the LLM to `wezterm_dispatch`. This prevents the LLM from using both systems in parallel (which used to produce duplicated work: two sets of agents running the same task).

7. **Results** — each agent is instructed to save its final report to `~/.pi/dispatch-results/<task-id>/<agent-name>.md` using the `write` tool. A fallback in the PowerShell script captures terminal output via `wezterm cli get-text` if the agent forgets.

8. **Manifest** — each dispatch writes a `manifest.json` with the task metadata, agent list, and pane IDs. This lets `collect_dispatch_results` find and merge everything later.

9. **Live tracking** — after dispatch, the extension polls the results directory every 5 seconds. When a result file appears, a notification is queued and flushed to the user on the next turn event. A live widget in the pi footer shows overall progress, and it's cleared automatically after `/collect`.

---

## Troubleshooting

**Nothing happens when I run `/dispatch`:**
- Verify the extension loaded: check `pi` startup logs for `wezterm-dispatch`
- Verify `wezterm cli --help` works from PowerShell
- Check `~/.pi/agent/extensions/wezterm-dispatch.ts` exists

**`Warning: Unknown tool "read bash grep find ls write"`:**
- PowerShell treats comma-separated values as array literals. The extension quotes `--tools` to prevent this. If you see this message, your extension file is outdated — update to the latest.

**Agents ask you to paste code / share the repo instead of reading files:**
- The agents have filesystem access via their tools — they shouldn't ask. The extension's system prompt explicitly instructs them to work autonomously. If you see this, update to the latest version.

**Agents keep working after completing their report ("buffer bug"):**
- Fixed in v0.2.0. If the prompt has newlines, older versions would pass them as argument separators to pi, making it process fragments as separate messages. Latest version uses pi's `@file` syntax.

**Panes open but agents use the wrong model / fail with "No API key found for anthropic":**
- Fixed in v0.2.0. Agent `.md` model fields are now ignored — the extension always uses the GPT default from your `settings.json`.

**`/collect` says no results:**
- The agents haven't saved yet — wait longer or check with `/status`
- The agents may have crashed — check the pane contents directly in WezTerm

**Command error `command.handler is not a function`:**
- You have an outdated extension. Update to the latest version.

---

## Project structure

```
pi-wezterm-dispatch/
├── extension.ts                    # The main extension (TypeScript, loaded dynamically by pi)
├── agents/                         # Example specialist agent definitions
│   ├── researcher.md
│   ├── code-analyst.md
│   ├── implementer.md
│   ├── security-auditor.md
│   └── tester.md
├── package.json
├── LICENSE
└── README.md
```

---

## Changelog

### v0.2.0

- **BREAKING:** Removed dispatch templates and the `dispatch_from_template` / `list_dispatch_templates` tools. Templates were rigid and forced fixed agent combinations. Dispatch is now fully dynamic.
- **BREAKING:** Removed `list_dispatch_agents` tool. The `/dispatch` command now includes the agent list directly in its prompt.
- **NEW:** Dynamic agent matching — LLM picks existing agents from `~/.pi/agent/agents/` (plus pi-subagents built-ins `general-purpose`, `Explore`, `Plan`) and generates dynamic agents to fill gaps
- **NEW:** `task` parameter in `wezterm_dispatch` — the specific work, sent as the user message to every agent. Agents with `name` get their preprompt as role context; agents with `prompt` get a custom role. Both can be combined.
- **NEW:** GPT-only model filter — reads `enabledModels` from `settings.json` and filters to GPT family, with a model selection guide injected into the system prompt
- **NEW:** Agent tool blocking — `Agent`, `get_subagent_result`, `steer_subagent` from pi-subagents are intercepted and rejected with a message redirecting to `wezterm_dispatch`
- **NEW:** Reinforced sub-agent system prompt — explicit workflow, working directory injection, prohibition of chat-style responses ("paste the file", "share the repo")
- **FIX:** UTF-8 encoding — scripts written with BOM, `chcp 65001` forced, prompt passed via separate UTF-8 file. Non-ASCII characters (`é`, `ñ`, etc.) no longer get corrupted.
- **FIX:** Argument splitting — prompt is now passed to pi via `'@file'` syntax instead of a PowerShell variable. Prevents Windows' `CommandLineToArgvW` from splitting multi-line prompts into multiple "message" arguments (the "buffer bug").
- **FIX:** `--tools` argument is now quoted to prevent PowerShell from interpreting comma-separated values as an array literal.
- **FIX:** Widget cleanup — the dispatch status widget is removed after `/collect` instead of lingering.
- **REMOVED:** Per-agent `model` field in `.md` files is ignored. This prevents failures when an agent's pinned model isn't available in the user's environment. The LLM picks the model dynamically at dispatch time.

### v0.1.0

- Initial release.

---

## Contributing

This is a personal project, but PRs are welcome for:
- New specialist agent definitions
- Bug fixes (Windows-specific is fine — this is Windows-only by design)

---

## License

MIT — see [LICENSE](./LICENSE)

## Credits

Built on top of [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) by [Mario Zechner](https://github.com/badlogic).
