# pi-wezterm-dispatch

A [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) extension that dispatches tasks to multiple specialist agents, each running in its own **WezTerm pane**. See all agents working simultaneously in a grid layout, then collect their results back into your main session for synthesis.

> **Windows-only.** Uses PowerShell scripts and Windows-native paths. Linux/macOS support is not currently planned.

---

## What it does

You describe a task. The extension:

1. **Analyzes** available specialist agents (researcher, security auditor, code analyst, etc.)
2. **Opens a WezTerm grid** with one pane per agent, each running an independent `pi` session
3. **Tracks status live** — notifications pop up as each agent finishes
4. **Collects results** on demand — bringing all reports back into the main session for a unified synthesis

### Example

```
You: /dispatch audit
```

Instantly opens a 2-pane WezTerm layout:

```
┌──────────────────────────┬──────────────────────────┐
│   Security Auditor       │   Code Analyst           │
│   (running on Sonnet)    │   (running on Sonnet)    │
│                          │                          │
│   Analyzing OWASP...     │   Mapping architecture...│
└──────────────────────────┴──────────────────────────┘
```

When they finish, say `/collect` and the main agent merges both reports into a single unified analysis.

---

## Features

- **Grid pane layout** — see all agents working at once (auto-calculated from agent count)
- **Live status widget** — the pi footer shows which agents are running/done
- **Auto-notifications** — popups when individual agents finish
- **Dispatch templates** — pre-configured workflows (`/dispatch audit`, `/dispatch research`, `/dispatch full-review`)
- **Result collection** — merges reports from all dispatched agents into your main session
- **Terminal capture fallback** — if an agent forgets to save its report, captures the pane's output automatically
- **Isolated agents** — each agent runs with a clean system prompt that blocks delegation loops

---

## Requirements

| Requirement | Notes |
|---|---|
| **Windows 10/11** | PowerShell-based scripts, Windows paths |
| **[pi-coding-agent](https://www.npmjs.com/package/@mariozechner/pi-coding-agent)** `>= 0.65.0` | The host framework |
| **[WezTerm](https://wezfurlong.org/wezterm/)** with CLI in PATH | Required for `wezterm cli spawn`, `split-pane`, `get-text` |
| **Anthropic / compatible API key** | For running the pi agents |

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

   # Example agents (optional but recommended)
   mkdir -Force $HOME\.pi\agent\agents
   Copy-Item agents\*.md $HOME\.pi\agent\agents\

   # Dispatch templates (optional but recommended)
   mkdir -Force $HOME\.pi\agent\dispatch-templates
   Copy-Item dispatch-templates\*.md $HOME\.pi\agent\dispatch-templates\
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
├── dispatch-templates/             ← pre-configured dispatches (.md)
│   ├── audit.md
│   ├── research.md
│   └── full-review.md
└── dispatch-results/               ← auto-created at dispatch time
    └── <task-id>/
        ├── manifest.json
        ├── <agent-name>.md         ← each agent's saved report
        └── ...
```

---

## Usage

### 1. Dispatch via template (simplest)

Templates are pre-configured combinations of agents + prompts:

```
/dispatch audit         # security-auditor + code-analyst
/dispatch research      # researcher + Explore
/dispatch full-review   # 4-agent complete project review
```

Templates support placeholders:
- `{working_dir}` — current working directory
- `{task}` — the task you describe

### 2. Dispatch manually (custom agents + prompts)

Just describe what you want and mention `wezterm_dispatch`:

```
Use wezterm_dispatch to audit the project at C:\my-project.
Focus on the authentication module and the payment processing flow.
```

The LLM will:
1. Call `list_dispatch_agents` to see what's available
2. Pick the right agents for the task
3. Write custom prompts tailored to each agent's specialty
4. Open WezTerm panes and start them

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
| `/dispatch` | Show available templates and custom agents |
| `/dispatch <template>` | Dispatch using a pre-configured template |
| `/status` | Show current dispatch status |
| `/collect` | Collect and synthesize results from the latest dispatch |

## Tools (for the LLM)

| Tool | Purpose |
|---|---|
| `list_dispatch_agents` | List all available agents (custom + built-in) |
| `list_dispatch_templates` | List all dispatch templates |
| `wezterm_dispatch` | Open WezTerm panes with agents + task prompts |
| `dispatch_from_template` | Dispatch using a template with optional task override |
| `collect_dispatch_results` | Read and return all agent reports |

---

## Creating custom agents

Drop a markdown file into `~/.pi/agent/agents/<name>.md`:

```markdown
---
name: db-migrator
display_name: Database Migration Agent
description: Plans and executes schema migrations safely
model: anthropic/claude-sonnet-4-6
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
| `model` | Any model pi supports, e.g. `anthropic/claude-sonnet-4-6` |
| `thinking` | `off`, `low`, `medium`, `high`, `xhigh` |
| `max_turns` | Max agent loop turns |
| `tools` | Comma-separated: `read,bash,grep,find,ls,write,edit` |
| `enabled` | `true`/`false` |
| `prompt_mode` | `replace` or `append` (replace is safer for dispatch) |

---

## Creating custom templates

Drop a markdown file into `~/.pi/agent/dispatch-templates/<name>.md`:

```markdown
---
name: my-template
display_name: My Custom Template
description: Describes what this template does
layout: grid
---

## researcher
Research {task}. Focus on {working_dir}. Produce a comprehensive report.

## code-analyst
Analyze the architecture at {working_dir} in the context of {task}.
```

- Each `## agent-name` section defines one agent and its prompt template
- `{working_dir}` and `{task}` are replaced at dispatch time
- `layout: grid` (default) or `layout: tabs`

Use it: `/dispatch my-template` or via the LLM: *"Use dispatch_from_template with template 'my-template'"*.

---

## How it works (technical)

1. **Spawn phase** — for each dispatched agent, the extension:
   - Writes a temporary PowerShell script to `~/.pi/agent/dispatch_<agent>_<timestamp>.ps1`
   - Writes a clean system prompt file to `~/.pi/agent/dispatch_<agent>_<timestamp>_system.txt`
   - Calls `wezterm cli spawn` (first pane) or `wezterm cli split-pane` (subsequent panes) to create the grid
   - Each pane runs: `pi --no-extensions --no-skills --model <model> --system-prompt @<system-file> --tools <tools> <task-prompt>`

2. **Why `--no-extensions`?** To remove the `Agent` tool from the dispatched agent's environment — otherwise it would try to spawn its own sub-agents, creating an infinite delegation loop. The dispatched agent only has core pi tools (`read`, `bash`, `grep`, `find`, `ls`, `write`, `edit`).

3. **Why `--system-prompt` (not `--append`)?** A full replace strips pi's default system prompt that mentions sub-agent delegation. The agent only sees our clean, specialist-focused prompt.

4. **Results** — each agent is instructed to save its final report to `~/.pi/dispatch-results/<task-id>/<agent-name>.md` using the `write` tool. A fallback in the PowerShell script captures terminal output via `wezterm cli get-text` if the agent forgets.

5. **Manifest** — each dispatch writes a `manifest.json` with the task metadata, agent list, and pane IDs. This lets `collect_dispatch_results` find and merge everything later.

6. **Live tracking** — after dispatch, the extension polls the results directory every 5 seconds. When a result file appears, a notification is queued and flushed to the user on the next turn event. A live widget in the pi footer shows overall progress.

---

## Troubleshooting

**Nothing happens when I run `/dispatch`:**
- Verify the extension loaded: check `pi` startup logs for `wezterm-dispatch`
- Verify `wezterm cli --help` works from PowerShell
- Check `~/.pi/agent/extensions/wezterm-dispatch.ts` exists

**Panes open but agents say "I don't have tools":**
- Usually a `pi` version mismatch. Update with `npm i -g @mariozechner/pi-coding-agent@latest`

**Panes open but agents keep delegating to sub-agents:**
- The extension uses `--no-extensions` to prevent this. If you see it happening, make sure you have the latest version of this extension (the earlier versions had this bug).

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
├── dispatch-templates/             # Pre-configured dispatch workflows
│   ├── audit.md
│   ├── research.md
│   └── full-review.md
├── package.json
├── LICENSE
└── README.md
```

---

## Contributing

This is a personal project, but PRs are welcome for:
- New dispatch templates
- New specialist agent definitions
- Bug fixes (Windows-specific is fine — this is Windows-only by design)

---

## License

MIT — see [LICENSE](./LICENSE)

## Credits

Built on top of [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) by [Mario Zechner](https://github.com/badlogic).
