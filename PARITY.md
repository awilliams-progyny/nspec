# nSpec Parity Snapshot (Internal)

This file is an internal product-analysis note, not end-user documentation.

## Snapshot Metadata

- Reviewed: 2026-03-10
- nSpec package version: 0.2.4
- Scope: spec workflow UX and implementation parity themes

## Current nSpec Position

### Strengths

- Spec-first pipeline with explicit Verify stage.
- Strong customization controls (`steering`, prompt overrides, legacy role fallback).
- Supervised task execution with diff review and command approval controls.
- Persistent task progress via `_progress.json`.

### Known constraints

- Extension-host tests are manual (not CI-blocking).
- Multi-turn pre-generation clarification is still lighter than fully guided chat-first flows.
- Some panel UX items remain iterative (for example deeper per-task controls in webview).

## Behavior Truths to Preserve

- Extension and CLI are different runtime surfaces; defaults differ.
- `codex-ui` is the extension default provider.
- CLI defaults are environment-driven (`NSPEC_MODEL` defaults to `gpt-4o`).
- `_sections` is removed and no longer supported.

## Priority Parity Work Themes

1. Clarification quality before first draft generation.
2. Faster import-onboarding from existing docs in panel/chat paths.
3. UX polish for supervised task execution loops.

## Out of Scope for This File

- Marketing claims.
- External benchmark scorecards as release truth.
- API/SDK compatibility guarantees.

For user-facing guidance, use:

- `README.md`
- `AGENTS.md`
- `readMe/INDEX.md`
