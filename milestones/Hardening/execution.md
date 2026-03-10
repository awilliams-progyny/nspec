# Documentation Hardening + Zero-Warning Quality Plan

Execution report for `milestones/Hardening/plan.md`.
Date: 2026-03-10

## Execution Summary

Before:

- The docs did not always match the real app behavior.
- One code warning was still allowed.
- Extension tests were fragile and failed easily.
- There was no strong check to stop new serious security issues.

After:

- The docs now match how the app really works.
- Code checks are strict and warnings are not allowed.
- Extension tests run in a stable, repeatable way.
- New serious security issues are blocked by an audit gate.

## Completed Work by Plan Area

### 1) Documentation trust and clarity hardening

Implemented:

- Reworked `README.md` into a front-door flow (install, provider selection, happy path, troubleshooting, deep links).
- Reconciled extension-vs-CLI defaults and provider behavior across docs.
- Added docs navigation entrypoint: `readMe/INDEX.md`.
- Updated `AGENTS.md`, `readMe/PROMPTS.md`, `readMe/EXAMPLE-USAGES.md`, and `readMe/SPEC-TAXONOMY.md` for consistency.
- Reconciled drift in `CHANGELOG.md` and `PARITY.md`.
- Standardized messaging that `_sections` is removed and unsupported.

### 2) Zero-warning code quality posture

Implemented:

- Removed `no-constant-condition` warning by refactoring the stream loop in `src/lmClient.ts`.
- Added strict lint script: `lint:strict` (`--max-warnings=0`).
- Added aggregate quality script: `quality:check` (strict lint + format check + typecheck + unit tests).
- Added explicit `typecheck` script.

### 3) Manual extension test reliability

Implemented:

- Added committed fixture workspace: `test-workspace/README.md`.
- Updated `test:extension` to compile before running extension tests.
- Updated extension test runner to clear `ELECTRON_RUN_AS_NODE` for reliable VS Code host launch.
- Fixed extension test suite runtime issues discovered during execution:
  - Mocha UI mismatch (`suite/test` required `tdd` UI).
  - Extension ID mismatch (`awilliams.nSpec` vs stale value).
  - Ensured extension activation before command assertions.

### 4) Docs and security guardrails

Implemented:

- Added `scripts/check-docs.mjs` and `docs:check` script with deterministic checks:
  - local markdown links
  - package/doc version parity
  - `_sections` removed/unsupported drift checks in active docs
- Added `scripts/audit-gate.mjs` and `audit:gate` script.
- Added baseline file: `security/audit-baseline.json`.
- `audit:gate` fails only for new high/critical vulnerabilities not in baseline.

### 5) CI alignment

Implemented:

- Updated `.github/workflows/ci.yml` to run:
  - `npm run quality:check`
  - `npm run docs:check`
  - `npm run audit:gate`
- Extension-host tests remain manual-only and are not CI-blocking.

## Validation Results

Passed locally:

1. `npm run lint:strict`
2. `npm run quality:check`
3. `npm run docs:check`
4. `npm run audit:gate`
5. `npm run test:extension`
6. `npm run verify:runtime`

## Notable Execution Details

- `npm run test:extension` initially failed due environment/runtime harness issues even after fixture creation.
- Root cause included `ELECTRON_RUN_AS_NODE=1` in environment and stale extension test assumptions.
- Test harness and test suite were corrected so extension-host tests now pass consistently.

## Files Added

- `milestones/Hardening/execution.md`
- `readMe/INDEX.md`
- `scripts/check-docs.mjs`
- `scripts/audit-gate.mjs`
- `security/audit-baseline.json`
- `test-workspace/README.md`

## Files Updated (High Impact)

- `.github/workflows/ci.yml`
- `package.json`
- `package-lock.json`
- `src/lmClient.ts`
- `test/run-extension-tests.js`
- `src/test/suite/index.ts`
- `src/test/suite/extension.test.ts`
- `README.md`
- `AGENTS.md`
- `CONTRIBUTING.md`
- `CHANGELOG.md`
- `PARITY.md`
- `readMe/PROMPTS.md`
- `readMe/EXAMPLE-USAGES.md`
- `readMe/SPEC-TAXONOMY.md`
- `test-harness.mjs`

## Scope/Constraint Notes

- Existing unrelated deletions in `milestones/spec-customization/*` were intentionally left untouched per instruction.
