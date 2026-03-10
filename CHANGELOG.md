# Changelog

## [0.2.4] — 2026-03-10

### Changed

- Documentation hardening across README, AGENTS, and `readMe/*` to clarify extension vs CLI defaults and provider behavior.
- Added docs index at `readMe/INDEX.md`.
- Updated CI to run strict quality, docs checks, and security audit gating.

### Fixed

- Removed ESLint constant-condition warning in `src/lmClient.ts` streaming loop.
- Restored extension-host test reliability by committing `test-workspace/` fixture used by launch/test flows.

### Quality and Security

- Added `lint:strict`, `typecheck`, and `quality:check` scripts.
- Added `docs:check` guardrail (local links + version parity + `_sections` drift checks).
- Added `audit:gate` guardrail with committed high/critical baseline keys.

### Customization compatibility

- `_sections` remains removed and unsupported.
- `lint-customization` continues to flag `_sections` as invalid.

## [0.2.0] — 2026-02-26

### Added

- Requirements -> Design -> Tasks -> Verify stage pipeline.
- Verify stage with health score, coverage matrix, and gap report.
- Task progress persistence via `_progress.json`.
- Extension panel workflows, refinement, cascade, and supervised diff review.
- CLI flows for init/generate/cascade/verify/refine/status/check-tasks/import.
- Prompt customization layers (`steering`, `_role` legacy, `_prompts` stage overrides).

### Notes

- Some mechanisms introduced around this period were later simplified.
- `_sections` was subsequently removed and is no longer supported in current releases.
