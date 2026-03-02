# nSpec Taxonomy: Customization Without Hidden Complexity

## Flow Summary

nSpec prompt assembly is now one path for panel, CLI, and chat generation:
1. Resolve the spec path (`.specs/<name>/`) and stage (`requirements|design|tasks|verify`).
2. Read config values from `.specs/config.json` and `.specs/<name>/spec.config.json`.
3. Build context layers:
- Workspace steering (`.specs/steering/*.md`, alphabetical)
- Optional legacy workspace steering (`.specs/_steering.md`)
- Optional spec steering (`.specs/<name>/_steering.md`)
- Optional legacy role override (`.specs/<name>/_role.md` then `.specs/_role.md`)
4. Resolve requirements format (`override > spec config > workspace config > default`).
5. Resolve stage prompt source:
- Spec override `.specs/<name>/_prompts/<stage>.md`
- Else workspace override `.specs/_prompts/<stage>.md`
- Else built-in template from `src/core/prompts.ts`
6. Generate stage output markdown (`requirements.md`, `design.md`, `tasks.md`, `verify.md`).
7. Persist runtime state (`_progress.json`, updated `spec.config.json` when needed).

This is implemented by `src/core/promptAssembly.ts` and consumed by panel + CLI + chat.

## System/Extension Controls (Code-Owned)

These are not user markdown files. They are extension behavior you influence indirectly.

| System Control | Best For | Responsibility | Effect | Example |
|---|---|---|---|---|
| `src/core/prompts.ts` built-in templates | Stable defaults | Defines default stage prompt text and output rules | Baseline quality when no `_prompts` overrides exist | Design includes architecture + Mermaid sequence requirement |
| `src/core/promptAssembly.ts` | Predictable precedence | Applies merge/replace rules and builds source map | Same composition behavior across panel/CLI/chat | `spec _prompts/design.md` always wins over workspace prompt |
| `src/core/specStore.ts` loaders | File resolution | Loads config, legacy role, steering, prompt override files | Determines what content is available to prompt assembly | Steering files loaded alphabetically from `.specs/steering/` |

## User Markdown You Can Author

| Markdown File | Best For | Responsibility | Effect on Generation | Example |
|---|---|---|---|---|
| `.specs/steering/*.md` | Shared project constraints | Encode product/tech/test conventions | Added to every stage prompt for every spec | `tech.md` says TypeScript strict + Vitest |
| `.specs/_steering.md` | One workspace steering file | Add global context in one place | Added after `steering/*.md` for all specs | Security/compliance policy text |
| `.specs/<name>/_steering.md` | Spec-local context | Add constraints for one spec | Added only for that spec | Payments spec requires idempotency keys |
| `.specs/_role.md` | Legacy workspace lens | Optional legacy role fallback | Replaces default role for all specs unless spec role exists | "You are a pragmatic staff engineer" |
| `.specs/<name>/_role.md` | Legacy spec lens | Optional legacy role fallback for one spec | Replaces role for that spec only | "You are a security architect" |
| `.specs/_prompts/<stage>.md` | Global stage behavior change | Full custom stage instructions | Replaces built-in stage prompt for all specs | Custom `tasks.md` format policy |
| `.specs/<name>/_prompts/<stage>.md` | One-spec stage control | Full custom stage instructions for one spec | Replaces built-in stage prompt for one spec+stage | Spec-specific `verify` scoring rules |
| `.specs/<name>/requirements.md` etc. | Output editing | Directly edit generated content | Changes current stage document; downstream regen uses this content | Manual clarification in requirements |

## Quick Mapping: Desired Effect -> What To Edit

Improve all generated outputs with project context:
- Edit `.specs/steering/product.md` and `.specs/steering/tech.md`

Add global skills instructions:
- Edit `.specs/steering/*.md` or `.specs/_steering.md`

Change only one spec's behavior:
- Edit `.specs/<name>/_steering.md`
- use `.specs/<name>/_role.md` only for legacy compatibility

Completely redefine one stage output format:
- Edit `.specs/<name>/_prompts/<stage>.md`

Switch requirements format default:
- Run `nspec config set requirements-format ears`
- This updates `.specs/config.json`

## Non-Markdown Config (Still Important)

| File | Best For | Responsibility | Example |
|---|---|---|---|
| `.specs/config.json` | Workspace defaults | Stores workspace-level settings | `{ "requirementsFormat": "ears" }` |
| `.specs/<name>/spec.config.json` | Per-spec settings | Stores mode/type/template and per-spec overrides | `{ "generationMode": "design-first", "requirementsFormat": "given-when-then" }` |

## Debug and Safety Commands

- `nspec explain-prompt <name> <stage>`
Purpose: show exactly which files and precedence rules formed the final system prompt.

- `nspec lint-customization [name]`
Purpose: catch risky customization patterns (oversized steering, conflicting requirements format, full prompt override warnings, removed `_sections` usage).

## Source of Truth

- Prompt defaults: `src/core/prompts.ts`
- Prompt assembly and precedence: `src/core/promptAssembly.ts`
- File loaders/storage: `src/core/specStore.ts`
- CLI command surface: `bin/nspec.mjs`
