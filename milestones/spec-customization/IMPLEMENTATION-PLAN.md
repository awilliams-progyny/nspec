# Spec Customization Implementation Plan (Project-Reviewed)

## Changes

1. Introduce one shared prompt assembly module and route all generation paths through it.
2. Keep customization semantics fixed and explicit:
- steering = add/merge context
- role = replace persona
- `_prompts` = full stage replacement
3. Add `explain-prompt` to show exact sources used for a stage prompt.
4. Add `lint-customization` to detect complexity regressions and unsafe config.
5. Remove duplicate composition logic in panel, CLI, and chat code paths.
6. Remove `_sections` from the supported customization surface and flag legacy usage.

## Goal

Make customization predictable, testable, and easy to debug by reducing composition behavior to one implementation path.

## Intended Impact

- Lower maintenance cost (one place to change composition behavior).
- Fewer “why did this prompt change?” issues.
- Faster onboarding: users can map desired output changes to one file type.
- Safer customization with guardrails before generation runs.

---

## Current State (From Project Review)

1. Prompt composition is duplicated in multiple entry points.
- Panel generation path composes directly in `src/SpecPanelProvider.ts`.
- CLI generation/cascade/import paths compose directly in `bin/nspec.mjs`.
- Chat participant composes requirements prompt directly in `src/chatParticipant.ts`.

2. Precedence logic is repeated.
- `loadCustomPrompt(...) || buildSystemPrompt(...)` appears across several paths.
- `loadSteering`, `loadRole`, and `requirementsFormat` resolution are reassembled repeatedly.

3. Taxonomy semantics are clear in docs but not yet enforced by one runtime contract.
- The taxonomy defines add/replace semantics.
- Runtime behavior still relies on repeated local implementations.

---

## Scope

### In Scope

- One composition service for all generation/refinement entry points.
- Source map output for explainability.
- Lint checks for complexity guardrails.
- Documentation alignment with enforced runtime behavior.
- Migration warnings for legacy `_sections` usage.

### Out of Scope

- New customization mechanism types.
- New profile system.
- Prompt framework redesign.

---

## Execution Plan

## Step 1: Build `promptAssembly` service

Action:
- Create `src/core/promptAssembly.ts`.
- Inputs: `specName`, `stage`, runtime options (e.g., `requirementsFormat` override, lightDesign).
- Outputs:
  - `systemPrompt`
  - `sourceMap` (template, config, steering, role, prompt overrides)
  - `mechanisms` (`merge`, `replace` decisions)

Done when:
- Service handles all existing precedence correctly.
- Service can be unit-tested without UI/CLI dependencies.

## Step 2: Migrate all composition call sites

Action:
- Replace local composition logic in:
  - `src/SpecPanelProvider.ts`
  - `bin/nspec.mjs`
  - `src/chatParticipant.ts`
- Keep behavior parity while removing duplicated assembly code.

Done when:
- `buildSystemPrompt` and loader functions are no longer orchestrated directly in those entry points.
- All generation/refine/import-transform paths use `promptAssembly`.

## Step 3: Add `explain-prompt`

Action:
- CLI command: `nspec explain-prompt <name> <stage>`.
- Output includes:
  - base template used
  - config sources (`.specs/config.json`, `spec.config.json`)
  - steering sources used
  - role source used
  - prompt override source (if any)
  - final mechanism summary

Done when:
- A developer can explain prompt content from one command.
- Command output matches actual generation behavior.

## Step 4: Add `lint-customization`

Action:
- CLI command: `nspec lint-customization [name]`.
- Initial checks:
  - steering file size threshold warnings
  - conflicting `requirementsFormat` workspace vs spec settings
  - full-override warning when `_prompts/<stage>.md` exists
  - legacy `_sections` presence warning with migration guidance

Done when:
- Lint reports clear actionable findings with file paths.
- Lint can run in CI non-interactively.

## Step 5: Update docs/examples to runtime truth

Action:
- Align docs and examples with enforced semantics and explain/lint commands.
- Keep examples minimal: one clear example per mechanism.
- Remove `_sections` from recommended examples and docs.

Done when:
- `SPEC-TAXONOMY.md`, README, and examples describe exactly what runtime does.

---

## Validation (Complexity Removed or Controlled)

1. Composition path count
- Target: one composition orchestrator.
- Check: code search shows no independent composition paths in panel/CLI/chat.

2. Mechanism semantics
- Target: three mechanisms only (steering merge, role replace, prompt full replace).
- Check: unit tests for each mechanism and precedence order.

3. Explainability coverage
- Target: every stage and entry path can be explained.
- Check: `explain-prompt` output verifies source usage for requirements/design/tasks/verify.

4. Guardrail coverage
- Target: common complexity regressions are caught before generation.
- Check: lint fixtures cover pass/fail for each rule.

---

## Exit Criteria

- All generation/refine/import-transform prompt assembly is centralized.
- `explain-prompt` is available and accurate.
- `lint-customization` is available and useful.
- Duplicate composition code removed from entry points.
- `_sections` is removed from the supported customization surface.
- Docs and examples match runtime behavior.
