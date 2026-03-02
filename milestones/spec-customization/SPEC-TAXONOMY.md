# nSpec Taxonomy: How Customization Actually Works

## Flow Summary

nSpec generation uses this runtime flow:
1. Start from built-in stage templates (Requirements/Design/Tasks/Verify behavior in code).
2. Load JSON controls: workspace `.specs/config.json` and spec `.specs/<name>/spec.config.json` (for settings like `requirementsFormat`, mode, template metadata).
3. Build context layers by merging steering (`.specs/steering/*.md`, optional `_steering.md`) and role (`_role.md`).
4. Apply customization controls for the requested stage:
   - `_prompts/<stage>.md` = full prompt replacement
   - `_sections/<stage>.md` = additive section requests
5. Generate/update stage outputs (`requirements.md` → `design.md` → `tasks.md` → `verify.md`, or bugfix stage equivalents).
6. Feed downstream stages from upstream outputs (for example, `requirements.md` drives `design.md`, then `tasks.md`).
7. Persist runtime state (`_progress.json`, config updates) so task selection/completion and spec settings survive regeneration.

In practice:
- Edit output docs when you want to change *this spec’s current content*.
- Edit customization markdown when you want to change *how generation behaves*.

---

## Important Clarification

There are **no hard-locked markdown files** inside `.specs/`.
- Stage markdown files are editable.
- Customization markdown files are editable.

What is not directly editable as markdown is the **built-in system behavior** in code (default prompt templates, precedence logic, merge logic).

---

## A) System/Extension-Owned Markdown Behavior (Not User-Defined by Default)

These are the markdown behaviors nSpec provides out of the box. You can influence them, but the base contract comes from extension code.

| System Behavior | Best For | Responsibility | Effect on Output | Example |
|---|---|---|---|---|
| Built-in Requirements template | Consistent requirement quality by default | Defines default structure and rules for requirements generation | Produces FR-style requirements with acceptance criteria unless overridden | Generated `requirements.md` includes structured functional + non-functional sections |
| Built-in Design template | Baseline architecture/design completeness | Defines required design sections and flow expectations | Produces architecture-focused `design.md` from requirements | Generated design includes architecture/components/data/flow guidance |
| Built-in Tasks template | Executable implementation planning | Defines checkbox task format and traceability expectations | Produces phase-based `tasks.md` with requirement mappings | Task line format with effort and `_Requirements: FR-*` mapping |
| Built-in Verify template | Quality and drift detection | Defines verification rubric and coverage checks | Produces `verify.md` highlighting gaps and readiness | Verify output flags uncovered/weakly covered requirement areas |
| Pipeline stage chaining | End-to-end spec lifecycle | Uses previous stage outputs as next stage inputs | Keeps Requirements→Design→Tasks→Verify coherent | Updating requirements and regenerating design/tasks changes downstream artifacts |

Notes:
- This section is about **default system behavior**, not files you author.
- The source for these defaults is code (`src/core/prompts.ts`, loaders in `src/core/specStore.ts`).

---

## B) User-Creatable Markdown (Customization Controls)

These are the markdown files you create when you want a specific effect.

| Markdown You Create | Best For | Responsibility | Effect on Generation | Example |
|---|---|---|---|---|
| `.specs/steering/*.md` | Persistent project context | Provide stable product/tech/testing constraints | Adds context to all stage prompts | `tech.md`: "Use Vitest, TypeScript strict mode, no `any`" |
| `.specs/_steering.md` | Single consolidated steering file | Add workspace-level context in one place | Adds to steering context chain | "All external APIs require retry + timeout policy" |
| `.specs/<name>/_steering.md` | Spec-specific context | Add constraints for one spec | Adds context only for that spec | "For this payments spec, enforce idempotency" |
| `.specs/_role.md` | Default writing posture | Set workspace role/persona | Replaces default role when no spec role exists | "You are a pragmatic staff engineer focused on maintainability" |
| `.specs/<name>/_role.md` | One-spec role specialization | Set role for one spec | Replaces role for that spec | "You are a security architect for auth boundaries" |
| `.specs/_prompts/<stage>.md` | Global behavior change for a stage | Fully define stage instructions | **Full replace** of built-in prompt for that stage | Custom `tasks.md` prompt forcing strict dependency ordering |
| `.specs/<name>/_prompts/<stage>.md` | One-spec stage behavior change | Fully define stage instructions for one spec | **Full replace** for that spec+stage | One spec requires custom `verify` scoring rubric |
| `.specs/<name>/_sections/<stage>.md` | Lightweight structure tweaks | Request extra section headings | **Additive** section extension, not full behavior replacement | Requirements adds `## Requirement Gaps` and `## Open Questions` |

---

## Customization Mechanisms (Fast Rules)

- **Add/Merge context**: steering files (`steering/*.md`, `_steering.md`)
- **Replace persona**: `_role.md`
- **Replace generation logic**: `_prompts/<stage>.md`
- **Append structure only**: `_sections/<stage>.md`

Use `_sections` first when possible. Use `_prompts` only when you intentionally want full control.

---

## Quick Recipes (Desired Effect → What To Edit)

I want better domain grounding everywhere:
- Edit `.specs/steering/product.md` and `.specs/steering/tech.md`

I want one extra quality section in requirements without rewriting prompt logic:
- Edit `.specs/<name>/_sections/requirements.md`
- Add lines like:
  - `Requirement Gaps`
  - `Open Questions`

I want tasks generation to follow a strict custom format everywhere:
- Edit `.specs/_prompts/tasks.md` (full replacement)

I want one spec to behave differently from all others:
- Edit `.specs/<name>/_prompts/<stage>.md` (full replacement for that scope)

I want EARS instead of Given/When/Then by default:
- `nspec config set requirements-format ears`
- This writes `.specs/config.json` (JSON control file, not markdown)

---

## Non-Markdown But Important Controls

` .specs/config.json `
- Best for: workspace defaults
- Responsibility: stores config like `requirementsFormat`
- Effect: changes default requirements format resolution
- Example:
```json
{ "requirementsFormat": "ears" }
```

` .specs/<name>/spec.config.json `
- Best for: per-spec behavior
- Responsibility: stores mode/type/template and per-spec overrides
- Effect: spec-local settings win over workspace defaults for that spec
- Example:
```json
{ "generationMode": "requirements-first", "requirementsFormat": "given-when-then", "version": "2.1" }
```

---

## Source of Truth

- Prompt defaults and branching: `src/core/prompts.ts`
- Loader/precedence for steering, role, prompts, sections: `src/core/specStore.ts`
- CLI config + requirementsFormat resolution: `bin/nspec.mjs`
- Panel requirements-format behavior: `src/SpecPanelProvider.ts`
