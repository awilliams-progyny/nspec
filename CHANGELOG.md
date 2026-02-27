# Changelog

## [0.2.0] — 2026-02-26

### Added

**Core pipeline**
- Requirements → Design → Tasks → Verify spec pipeline with full stage cascade
- Health score (0–100), coverage matrix, and gap report in the Verify stage
- Checkbox task list with effort sizing (S/M/L/XL) and FR traceability in Tasks

**AI providers**
- OpenAI API (direct, any OpenAI-compatible endpoint including Ollama)
- Anthropic API (direct streaming via `messages` endpoint)
- VS Code `vscode.lm` (GitHub Copilot) with automatic model fallback
- Interactive model picker: **nSpec: Select AI Model**

**Panel (VS Code + Cursor)**
- Webview panel with stage breadcrumb navigation (`Ctrl+Shift+K` / `Cmd+Shift+K`)
- New Spec wizard supporting feature, bugfix, and design-first spec types
- Inline Refine bar for feedback-driven stage revision
- Cascade button to regenerate all stages downstream of the current one
- Supervised task execution: AI proposes file changes, each diff opens in VS Code diff editor for accept/reject review
- Task completion detection (`nSpec: Check Task Completion`) — scans workspace for evidence tasks are implemented
- Task progress persisted in `_progress.json` (survives stage regeneration)

**Agent integration**
- `@nspec` chat participant for VS Code Copilot chat (`/spec`, `/status`, `/refine`, `/context` commands)
- Vibe-to-spec: generate a spec from a conversation transcript (`nSpec: Generate Spec from Conversation`)
- `spec:<name>` / `#spec:<name>` cross-reference syntax injects spec context into chat
- Codex chat integration via `@nspec` commands (`/spec`, `/status`, `/refine`, `/context`)

**OpenSpec customization**
- Per-spec and workspace-wide steering files (`_steering.md`, `steering/*.md`)
- Role overrides (`_role.md`)
- Full prompt overrides per stage (`_prompts/<stage>.md`)
- Extra output sections (`_sections/<stage>.md`)
- **nSpec: Setup Steering Files** auto-generates `product.md`, `tech.md`, `structure.md` from workspace
- **nSpec: Scaffold Custom Prompts** creates `_prompts/` scaffold for the active spec

**Integrations**
- Jira Cloud: create a spec from a User Story browse URL with credentials from VS Code settings
- Rovo MCP: auto-detect Rovo MCP configuration for enriched Jira + Confluence context in Cursor

**CLI** (`node bin/nspec.mjs`)
- `init`, `generate`, `cascade`, `verify`, `refine`, `status`, `check-tasks`, `import` commands
- Three verification schemes: `audit` (single-pass), `cove` (chain-of-verification), `committee` (combined)
- `vibe-to-spec` command: generate spec pipeline from a conversation file or stdin
- `--transform` flag for `import`: AI-converts arbitrary documents to nSpec format

**Hooks**
- File-save triggered automations via `.specs/hooks/*.json`
- Supports `onSave`, `onCreate`, `onDelete`, `manual` triggers with glob matching
- Status bar indicator shows active hook count; output logged to **nSpec Hooks** output channel

**Templates**
- Built-in spec templates for common starting points
- Template registry accessible via New Spec wizard

**Bugfix workflow**
- Dedicated bugfix spec type with root-cause analysis, reproduction steps, and fix verification stages

**Developer experience**
- `.env.example` with all CLI environment variables documented
- `test-harness.mjs` for prompt tuning with run comparison (`--tag` flag, diff across runs)
- Unit test suite (`npm test`) for core logic (task parsing, folder name normalization, hook resolution)
