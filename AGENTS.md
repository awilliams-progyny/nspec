# nSpec — Agent Instructions

> This file teaches coding agents (Codex, Cursor, etc.) how to work with the nSpec spec system.

## What is nSpec?

nSpec is a requirements-first planning system. Before writing code, you create structured specifications:
**Requirements → Design → Tasks → Verify**

Each spec lives in `.specs/<name>/` as markdown files. This gives you a traceable, verifiable plan before touching any code.

## Folder Structure

```
.specs/
├── <spec-name>/
│   ├── spec.config.json        # Auto-generated metadata
│   ├── requirements.md         # Functional & non-functional requirements
│   ├── design.md               # Technical architecture & component breakdown
│   ├── tasks.md                # Checkbox implementation plan with effort estimates
│   ├── verify.md               # Health score, coverage matrix, gap analysis
│   ├── _progress.json          # Task completion tracking
│   ├── _steering.md            # (optional) Domain context for this spec
│   ├── _role.md                # (optional) Override the AI's role preamble
│   ├── _prompts/               # (optional) Full prompt overrides per stage
│   │   └── requirements.md, design.md, tasks.md, verify.md
│   └── _sections/              # (optional) Extra output sections per stage
│       └── requirements.md, design.md, tasks.md, verify.md
├── steering/                   # (optional) Workspace-wide steering files
│   ├── product.md              # Product vision, target users
│   ├── tech.md                 # Technology stack, patterns, libraries
│   ├── structure.md            # Directory structure, module boundaries
│   └── testing.md              # Test conventions, coverage requirements
├── _steering.md                # (optional) Legacy workspace-wide domain context
├── _role.md                    # (optional) Workspace-wide role override
└── _prompts/                   # (optional) Workspace-wide prompt overrides
```

## CLI Commands

All commands are run via `node bin/nspec.mjs` (or `nspec` if linked).

### Initialize a new spec
```bash
nspec init <name>
# Creates .specs/<name>/ with spec.config.json
# Prints the folder path
```

### Generate a stage
```bash
# Requirements (needs --description)
nspec generate <name> requirements --description "Build a user auth system with OAuth2..."

# Design (reads requirements.md as input)
nspec generate <name> design

# Tasks (reads design.md as input)
nspec generate <name> tasks

# Verify (reads all three stages)
nspec generate <name> verify
```

### Verify with different schemes
```bash
nspec verify <name>                    # Default: audit (single-pass)
nspec verify <name> --scheme cove      # Chain of Verification (question-answer)
nspec verify <name> --scheme committee # Audit + CoVe synthesis (most thorough)
```

### Cascade (generate all downstream stages)
```bash
nspec cascade <name>                   # From design through verify
nspec cascade <name> --from tasks      # From tasks through verify
```

### Check status
```bash
nspec status           # List all specs with completion dots (●○○○)
nspec status <name>    # Detail view: stages, progress %, health score
```

### Refine a stage
```bash
nspec refine <name> <stage> --feedback "Add rate limiting to the auth requirements"
# If feedback is a question → prints inquiry response
# If feedback is a change request → updates the stage file
```

### Import an existing document
```bash
nspec import <name> <stage> <file>              # Copy file as a spec stage
nspec import <name> <stage> <file> --transform  # AI-convert to spec format first
# Stages: requirements, design, tasks, verify
# --transform converts PRDs, Notion exports, etc. into Given/When/Then format
```

### Set up agent instructions
```bash
nspec setup-agents     # Writes this AGENTS.md file
```

### Set up steering files
```bash
nspec setup-steering   # Generates steering files from workspace (product.md, tech.md, structure.md)
```

## Stage Pipeline

| Stage | Input | Output | Purpose |
|-------|-------|--------|---------|
| **requirements** | Feature description | FR-1..N, NFRs, constraints | What to build |
| **design** | requirements.md | Architecture, components, data models | How to build it |
| **tasks** | design.md | Checkbox list with S/M/L/XL estimates | What to code |
| **verify** | All three stages | Health score, coverage matrix, gaps | Is the spec complete? |

## When to Use CLI vs Direct Edit

| Action | Approach |
|--------|----------|
| Generate a new stage from scratch | CLI: `nspec generate` |
| Generate all remaining stages | CLI: `nspec cascade` |
| Run verification | CLI: `nspec verify` |
| Small wording tweaks | Direct edit the .md file |
| Add/remove a requirement | Direct edit, then `nspec cascade --from design` |
| Ask a question about the spec | CLI: `nspec refine <name> <stage> --feedback "..."` |
| Substantive rewrite of a section | CLI: `nspec refine` with change request |
| Import an external document as a stage | CLI: `nspec import` (with optional `--transform`) |
## Importing Existing Documents

When the user says "import this document as requirements" or similar:

1. `nspec import <name> requirements <file> --transform` — converts the document (PRD, Notion export, etc.) to Given/When/Then format
2. `nspec import <name> design <file>` — copy as-is without AI transformation
3. After import, cascade: `nspec cascade <name>` to generate downstream stages

The `--transform` flag uses AI to convert arbitrary documents into nSpec's structured format (numbered FRs, acceptance criteria, etc.). Without it, the file content is copied verbatim.

## Reading verify.md and Acting on Gaps

After running verify, check:

1. **Health Score** — Target 80+. Below 60 means significant gaps.
2. **Coverage Matrix** — Look for `UNCOVERED` FRs. These need tasks added.
3. **Cascade Drift** — Requirements without matching design, or design without tasks. Fix upstream first.
4. **Gap Report** — Actionable items. Address each one, then re-verify.

**Typical flow to fix gaps:**
1. Read verify.md and identify issues
2. Edit the upstream document (requirements.md or design.md)
3. Run `nspec cascade <name> --from design` to regenerate downstream
4. Run `nspec verify <name>` to confirm improvement

## OpenSpec Customization

To customize AI behavior for a specific spec:

- **`_steering.md`** — Add domain context (e.g., "This is a healthcare app, all data must be HIPAA compliant")
- **`_role.md`** — Override the AI's role (e.g., "You are a mobile game designer")
- **`_prompts/<stage>.md`** — Completely replace the system prompt for a stage
- **`_sections/<stage>.md`** — Add extra output sections (one per line)

Workspace-wide files in `.specs/` apply to all specs. Spec-specific files override workspace-wide.

## Steering Files

Steering files inject persistent project context into every AI prompt. They live in `.specs/steering/` and are loaded alphabetically.

### Setup
```bash
nspec setup-steering   # Auto-generates from workspace (package.json, README, tsconfig, etc.)
```

### What to put in steering files
- **`product.md`** — Product vision, target users, business context
- **`tech.md`** — Technology stack, framework conventions, library choices
- **`structure.md`** — Directory layout, module boundaries, naming conventions
- **`testing.md`** — Test frameworks, coverage requirements, testing patterns

### When to update steering files
- When you adopt a new library or framework
- When you establish a new coding convention
- When the project structure changes significantly
- When you add a new integration or external dependency

### How steering files work
- All `.specs/steering/*.md` files are concatenated (alphabetically) into the system prompt
- They are combined with `_steering.md` (workspace-wide) and `<spec>/_steering.md` (spec-specific)
- Precedence: `steering/*.md` → `_steering.md` → `<spec>/_steering.md`
- Removing a steering file does not break anything — they are additive

### Workspace context injection
For **design** and **tasks** stages, nSpec also reads key project files (package.json, tsconfig, directory structure, relevant source files) and injects them into the prompt. This happens automatically — no configuration needed.

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `NSPEC_API_KEY` | (required) | OpenAI or Anthropic API key |
| `NSPEC_API_BASE` | `https://api.openai.com/v1` | API base URL |
| `NSPEC_MODEL` | `gpt-4o` | Model to use for generation |
| `NSPEC_SPECS_DIR` | `.specs` (relative to cwd) | Specs folder path |

## Vibe-to-Spec Workflow

When the user asks you to "generate a spec" or "turn this into a spec" during a conversation:

1. Save the relevant conversation context to a temporary file
2. Run: `nspec vibe-to-spec <inferred-name> --transcript <file> --cascade`
3. The spec pipeline will be generated from the conversation context

### CLI usage
```bash
# From a file
nspec vibe-to-spec auth-feature --transcript chat.md

# From stdin
cat chat.md | nspec vibe-to-spec auth-feature

# With full cascade (generates requirements → design → tasks → verify)
nspec vibe-to-spec auth-feature --transcript chat.md --cascade
```

### What happens internally
1. The transcript is parsed by AI to extract feature scope, decisions, constraints, and open questions
2. Requirements are generated using the extracted description + full transcript as context
3. If `--cascade` is used, design → tasks → verify are generated downstream
4. The extracted context is saved in `spec.config.json` under `vibeContext` so downstream stages benefit from it

### Transcript format (flexible)
```
User: I'm thinking about adding OAuth support to the app
Assistant: There are several approaches. You could use...
User: Let's go with GitHub OAuth. We need session management too.
```

## Copilot / Codex Chat Integration

When using GitHub Copilot or Codex in VS Code chat, nSpec registers a `@nspec` chat participant:

- **`@nspec /spec <name>`** — Generate a spec from the chat conversation
- **`@nspec /status [name]`** — Show spec status
- **`@nspec /refine <name> <stage>`** — Refine a spec stage
- **`@nspec /context <name>`** — Inject a spec's content (requirements + design + tasks) as context

The chat participant extracts the conversation history from VS Code's chat context and runs the same vibe-to-spec pipeline.

## Supervised Execution

nSpec supports supervised per-task execution with diff review. This is the UI layer — Codex handles autonomous execution via AGENTS.md; this adds visual diff review and task-by-task approval.

### Per-task Run
In the VS Code panel, each incomplete task has a **Run** button. Clicking it:
1. Sends the task + spec context to the AI via `vscode.lm` tool-calling
2. The model proposes file changes (writeFile, editFile, runCommand)
3. Each change opens in VS Code's native diff editor
4. You accept or reject each change individually
5. Accepted changes are applied; rejected changes are discarded
6. The task is auto-marked complete if changes were accepted

### Task Completion Detection
Scan the workspace for evidence that tasks are already implemented:

```bash
nspec check-tasks <name>
```

This checks:
- **File existence** — filenames mentioned in backticks in task labels
- **Symbol grep** — class/function names mentioned in backticks
- **Package.json** — package dependencies referenced in tasks

Tasks scoring > 0.7 are marked COMPLETE, > 0.3 PARTIAL, otherwise INCOMPLETE.

In the VS Code panel, use **Check** (per-task) or **Check All** to run detection interactively.

### Run All Tasks (supervised)
Click "Run all tasks (supervised)" to execute all incomplete tasks sequentially:
1. Each task generates proposed changes via tool-calling
2. Diffs are shown for review between each task
3. Accept/reject per change
4. Completed tasks are marked; run can be cancelled mid-way

### Shell Command Allow-list
Shell commands proposed by `runCommand` require explicit approval via dialog. Configure auto-approved prefixes in VS Code settings:

```json
"nspec.allowedCommands": ["npm install", "npm run", "npx"]
```
