# nSpec Taxonomy: Customization Without Hidden Complexity

## Runtime split (important)

Prompt assembly rules are shared across extension and CLI.
Defaults are not identical:

- extension `lm` default model: `gpt-5.3-codex`
- CLI default model: `gpt-4o`

## Flow summary

nSpec prompt assembly is one path for panel, CLI, and chat:

1. Resolve spec path (`.specs/<name>/`) and stage (`requirements|design|tasks|verify`).
2. Read workspace and spec config values.
3. Build context layers (steering + legacy role fallback).
4. Resolve requirements format (`override > spec > workspace > default`).
5. Resolve stage prompt source (`spec override > workspace override > built-in`).
6. Generate stage markdown (`requirements.md`, `design.md`, `tasks.md`, `verify.md`).
7. Persist runtime state (`_progress.json`, `spec.config.json` updates as needed).

Core implementation:

- `src/core/promptAssembly.ts`
- `src/core/specStore.ts`
- `src/core/prompts.ts`

## Code-owned controls

| Control | Responsibility | Effect |
|---|---|---|
| `src/core/prompts.ts` | built-in stage templates | baseline output when no overrides exist |
| `src/core/promptAssembly.ts` | precedence/merge logic | consistent behavior across panel/CLI/chat |
| `src/core/specStore.ts` | file loading and resolution | determines customization inputs |

## User-authored markdown controls

| File | Scope | Effect |
|---|---|---|
| `.specs/steering/*.md` | workspace | persistent context for all specs |
| `.specs/_steering.md` | workspace | legacy workspace steering layer |
| `.specs/<name>/_steering.md` | spec | spec-local context |
| `.specs/_role.md` | workspace | legacy role fallback |
| `.specs/<name>/_role.md` | spec | legacy spec role fallback |
| `.specs/_prompts/<stage>.md` | workspace | full stage prompt override |
| `.specs/<name>/_prompts/<stage>.md` | spec | full stage prompt override for one spec |
| `.specs/<name>/<stage>.md` | spec output | direct edits to generated output |

## Supported vs removed mechanisms

Supported mechanisms:

- steering files
- `_role.md` (legacy fallback)
- `_prompts/<stage>.md` full overrides

`_sections` is removed and no longer supported.

## Quick mapping (intent -> edit)

Improve all outputs with shared project context:

- edit `.specs/steering/product.md`
- edit `.specs/steering/tech.md`

Change one spec behavior:

- edit `.specs/<name>/_steering.md`

Completely redefine one stage output format:

- edit `.specs/<name>/_prompts/<stage>.md`

Switch requirements default format:

- `nspec config set requirements-format ears`

## Non-markdown config

| File | Purpose |
|---|---|
| `.specs/config.json` | workspace defaults (for example `requirementsFormat`) |
| `.specs/<name>/spec.config.json` | per-spec config and overrides |

## Debug and safety commands

- `nspec explain-prompt <name> <stage>`
- `nspec lint-customization [name]`

`lint-customization` reports risky overrides and rejects `_sections` usage because that mechanism is removed.

## Related docs

- [INDEX.md](INDEX.md)
- [PROMPTS.md](PROMPTS.md)
- [EXAMPLE-USAGES.md](EXAMPLE-USAGES.md)
