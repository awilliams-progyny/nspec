# Spec Customization Plan Execution Summary

Date: 2026-03-02

## Scope Executed

Implemented the customization simplification plan with hard `_sections` removal and centralized prompt assembly.

## Completed Changes

1. Centralized prompt assembly
- Added `src/core/promptAssembly.ts`.
- `assembleSystemPrompt(...)` now resolves role, steering, config precedence, prompt overrides, and source map in one place.
- Added source map fields for explainability (`requirementsFormatSource`, `roleSource`, `steeringSources`, `promptOverrideSource`, `mechanisms`).

2. Migrated generation paths to shared assembly
- Updated `src/specManager.ts` to expose `assembleSystemPrompt(...)` wrapper.
- Updated `src/SpecPanelProvider.ts` to use centralized assembly for generation/import transform flows.
- Updated `src/chatParticipant.ts` requirements generation path to use centralized assembly.
- Updated `bin/nspec.mjs` generation/cascade/import/backfill/verify/vibe-to-spec/clarify paths to use centralized assembly.

3. Removed `_sections` runtime behavior
- Removed `_sections` handling from prompt context/runtime code.
- Removed `_sections` references from scaffold/example generation in `src/core/specStore.ts`.
- Removed `_sections` files from customization playground examples.

4. Added explainability command
- Added CLI command: `nspec explain-prompt <name> <stage>`.
- Command outputs effective prompt source chain and precedence details.

5. Added customization lint command
- Added CLI command: `nspec lint-customization [name]`.
- Checks include:
  - Steering size warnings
  - Conflicting workspace/spec `requirementsFormat`
  - Full prompt override warnings (`_prompts/<stage>.md`)
  - `_sections` presence errors

6. Aligned docs/examples to runtime truth
- Updated `AGENTS.md`, `README.md`, `examples/customization-playground/README.md`, and `milestones/spec-customization/SPEC-TAXONOMY.md`.
- Updated maximal-markdowns summary and removed `_sections` examples.

## Files Added

- `src/core/promptAssembly.ts`
- `milestones/spec-customization/EXECUTION-SUMMARY.md`
- `milestones/spec-customization/VERIFY-01-BUILD-TEST.md`
- `milestones/spec-customization/VERIFY-02-CLI-PROMPT-LINT.md`
- `milestones/spec-customization/VERIFY-03-SECTIONS-REMOVAL.md`

## Verification Docs

- `milestones/spec-customization/VERIFY-01-BUILD-TEST.md`
- `milestones/spec-customization/VERIFY-02-CLI-PROMPT-LINT.md`
- `milestones/spec-customization/VERIFY-03-SECTIONS-REMOVAL.md`
