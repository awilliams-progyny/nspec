# nSpec

> **Spec-driven development for VS Code + Codex.**  
> Turn a feature description into a traceable **Requirements → Design → Tasks → Verify** pipeline — then execute tasks with AI-reviewed diffs.

[![Version](https://img.shields.io/badge/version-0.2.0-blue)](https://github.com/nspec/nSpec/releases)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.93.0-007ACC)](https://marketplace.visualstudio.com/items?itemName=awilliams.nSpec)
[![License: MIT](https://img.shields.io/badge/License-MIT-green)](LICENSE)

---

## What is nSpec?

Most AI coding tools jump straight to code. nSpec makes you **plan first**.

You describe a feature. nSpec generates a structured spec — functional requirements, architecture design, a checkbox task list, and a verification report — all traceable back to each other. Then you execute tasks one at a time, reviewing every diff before it applies.

**The result:** AI-generated code you actually understand, with a paper trail showing *why* each decision was made.

---

## How it works

```
Describe feature  →  Requirements  →  Design  →  Tasks  →  Verify
                         FR-1..N      components  ☐ T-1    health score
                                      data models  ☐ T-2    gap report
                                                   ☐ T-3
```

Each stage feeds the next. If requirements change, cascade regenerates everything downstream automatically.

---

## Quick start

> **Requirement:** Use either `codex_delegate` mode (default) or configure Codex API mode.

### Prerequisites

- VS Code 1.93+
- OpenAI ChatGPT/Codex extension for delegate mode (`openai.chatgpt`), or
- Codex API key for API mode (`nspec.apiKey` or `NSPEC_API_KEY`/`OPENAI_API_KEY`)

### VS Code + Codex (recommended)

1. **Install:** Extensions panel → `⋯` menu → **Install from VSIX** → select `nSpec-*.vsix`
2. **Choose provider mode:** `nSpec: Provider` (`codex_delegate` by default)
3. **If using API mode:** set `nSpec: Api Key` (optional: model/base URL)
4. **Open the panel:** `Ctrl+Shift+K` (Windows/Linux) or `Cmd+Shift+K` (Mac)
5. **Create a spec:** Command Palette → **nSpec: New Spec** → enter a feature description → press Enter

Specs are stored in `.specs/`.

### Building from source

```bash
git clone https://github.com/nspec/nSpec.git
cd nSpec
npm install
npm run package          # produces nSpec-*.vsix
```

Install the `.vsix` via **Extensions → ⋯ → Install from VSIX**.

---

## Usage

| Action | How |
|--------|-----|
| Open panel | `Ctrl+Shift+K` / `Cmd+Shift+K`, or Command Palette: **nSpec: Open Panel** |
| Create a spec | Command Palette: **nSpec: New Spec** → enter name + description |
| Navigate stages | Breadcrumb in the panel: **1 Requirements › 2 Design › 3 Tasks › 4 Verify** |
| Refine a stage | Type feedback in the Refine bar beneath any stage → press **Refine** |
| Cascade downstream | Press **Cascade** to regenerate all stages below the current one |
| Run tasks (supervised) | Click **Run all tasks** in the Tasks stage — review each diff before it applies |
| Check task completion | Command Palette: **nSpec: Check Task Completion** |
| Diagnose Codex availability | Command Palette: **nSpec: Diagnose Codex Models** (prints API readiness + optional `vscode.lm` visibility diagnostics to Output → nSpec) |
| Custom prompts | Click the **✦ OpenSpec** badge in the breadcrumb to scaffold `_prompts/` |
| Setup steering | Command Palette: **nSpec: Setup Steering Files** |

---

## Customization Guides

Prefer example-first customization before tuning workflows.

- **Prompt system and precedence:** [readMe/PROMPTS.md](readMe/PROMPTS.md)
- **Example usage cookbook:** [readMe/EXAMPLE-USAGES.md](readMe/EXAMPLE-USAGES.md)
- **Taxonomy and responsibilities:** [readMe/SPEC-TAXONOMY.md](readMe/SPEC-TAXONOMY.md)
- **Playground examples:** [examples/customization-playground/README.md](examples/customization-playground/README.md)

---

## CLI

The CLI is designed for agent-driven workflows (Codex, scripts). It reads `NSPEC_API_KEY` from the environment.

### Setup

```bash
# Copy and fill in your API key
cp .env.example .env
# or export directly:
export NSPEC_API_KEY="sk-..."          # OpenAI
```

> Run `npm run compile` once before using the CLI so `out/core/` exists.

### Commands

```bash
node bin/nspec.mjs init <name>                         # Create an empty spec
node bin/nspec.mjs generate <name> requirements \
  --description "Build a user auth system..."          # Generate one stage
node bin/nspec.mjs cascade <name>                      # Generate design → tasks → verify
node bin/nspec.mjs verify <name> --scheme committee    # Thorough verification (best quality)
node bin/nspec.mjs refine <name> <stage> \
  --feedback "Add rate limiting requirements"          # Revise a stage
node bin/nspec.mjs status                              # List all specs
node bin/nspec.mjs status <name>                       # Detail view with health score
node bin/nspec.mjs check-tasks <name>                  # Scan codebase for task completion
node bin/nspec.mjs import <name> <stage> <file> \
  --transform                                          # Import & convert an existing doc
```

---

## Agent integration

### Codex supervised execution

In the Tasks stage, use **Run checked** or **Run all tasks (supervised)** to send task implementation prompts to Codex.

If Codex commands are unavailable in the current VS Code session, nSpec now shows a clear error with recovery actions (open extensions or reload window).

---

## Configuration reference

All settings are under **Settings → nSpec** (search `nspec` in the VS Code settings UI).

| Setting | Default | Description |
|---------|---------|-------------|
| `nspec.provider` | `codex_delegate` | Provider mode: `codex_delegate` (file-handshake via Codex/ChatGPT commands) or `codex_api` (direct API calls) |
| `nspec.apiKey` | `` | Codex API key used by nSpec generation |
| `nspec.apiBaseUrl` | `https://api.openai.com/v1` | Codex API base URL |
| `nspec.apiModel` | `gpt-5.3-codex` | Codex model used by nSpec generation |
| `nspec.specsFolder` | `.specs` | Folder (relative to workspace root) where specs are stored |
| `nspec.allowedCommands` | `["npm install","npm run","npx"]` | Command prefixes auto-approved during supervised task execution. All others require manual approval. |

---

## Spec structure

Each spec lives in `.specs/<name>/`:

```
.specs/
├── <name>/
│   ├── requirements.md      # Functional requirements (Given/When/Then, FR-N)
│   ├── design.md            # Architecture, components, data models
│   ├── tasks.md             # Checkbox task list with effort sizing and FR traceability
│   ├── verify.md            # Health score (0–100), coverage matrix, gap report
│   ├── _progress.json       # Task completion state (survives regeneration)
│   ├── _steering.md         # (optional) Domain context for this spec
│   ├── _role.md             # (optional, legacy) Role override (prefer steering skills)
│   └── _prompts/            # (optional) Full prompt overrides per stage
├── steering/                # Workspace-wide steering (product.md, tech.md, etc.)
└── _prompts/                # Workspace-wide prompt overrides
```

---

## OpenSpec customization

Override AI behaviour at any granularity without touching source code.

| File | Scope | What it does |
|------|-------|-------------|
| `.specs/steering/*.md` | All specs | Persistent context injected into every prompt (tech stack, conventions, etc.) |
| `.specs/_prompts/<stage>.md` | All specs | Replace the system prompt for a stage workspace-wide |
| `.specs/<name>/_steering.md` | One spec | Domain context for a specific spec |
| `.specs/<name>/_prompts/<stage>.md` | One spec | Replace the system prompt for one stage |
| `.specs/<name>/_role.md` | One spec | Legacy role fallback (prefer steering skills) |

Run **nSpec: Setup Steering Files** to auto-generate `product.md`, `tech.md`, and `structure.md` from your workspace.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| **Codex not available** | In `codex_delegate` mode, ensure `chatgpt.*`/`codex.*` commands are available and run **nSpec: Diagnose Codex Models**. In `codex_api` mode, set `nspec.apiKey` or env key. |
| **Generation failed** | Verify key/base URL/model in `nSpec` settings and check Output → nSpec for API error details. |
| **Run checked says no Codex commands** | Install/enable OpenAI Codex extension (`openai.chatgpt`) for command-based workflows. Generation does not depend on `vscode.lm`. |
| **CLI: NSPEC_API_KEY is required** | `export NSPEC_API_KEY="sk-..."` in your shell before running CLI commands. |
| **Panel empty or stale** | Reopen the panel. Make sure a folder is open (File → Open Folder) and `.specs/` exists. |
| **No workspace folder** | Open a folder (File → Open Folder) before creating specs. |
| **Tasks regeneration wiped my checkboxes** | `_progress.json` persists task state independently — checkboxes are restored automatically on next panel open. |

**Logs:** Output panel → select **nSpec** or **nSpec Hooks**.

---

## Security

- **Never commit API keys.** Use environment variables for CLI usage. See `.env.example`.
- The `.gitignore` excludes `.env`, `.env.*`, and `*.local.json` by default.
- Supervised task execution requires explicit approval for shell commands not in `nspec.allowedCommands`.

---

## Docs

- **CLI and agent usage:** [AGENTS.md](AGENTS.md)
- **Prompt system:** [readMe/PROMPTS.md](readMe/PROMPTS.md)
- **Example usages:** [readMe/EXAMPLE-USAGES.md](readMe/EXAMPLE-USAGES.md)
- **Spec taxonomy:** [readMe/SPEC-TAXONOMY.md](readMe/SPEC-TAXONOMY.md)
- **Customization playground:** [examples/customization-playground/README.md](examples/customization-playground/README.md)
- **Contributing:** [CONTRIBUTING.md](CONTRIBUTING.md)
- **Changelog:** [CHANGELOG.md](CHANGELOG.md)
