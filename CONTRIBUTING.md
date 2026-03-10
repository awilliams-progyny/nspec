# Contributing to nSpec

Thanks for your interest in contributing. This file covers build, test, and quality workflows used by this repository.

## Prerequisites

- **Node.js** 20+
- **npm** (or compatible package manager)
- **VS Code** or **Cursor** (for running the extension)

## Build

```bash
git clone https://github.com/nspec/nSpec.git
cd nSpec
npm install
npm run compile
```

- **Watch mode:** `npm run watch` — recompiles on file changes.
- **Package VSIX:** `npm run package` — produces `nSpec-*.vsix` for **Install from VSIX**.

## Quality checks

- **Lint:** `npm run lint` — developer-friendly lint run.
- **Strict lint:** `npm run lint:strict` — fails on any warning.
- **Lint (fix):** `npm run lint:fix` — applies auto-fixes.
- **Format:** `npm run format` — runs Prettier.
- **Format check:** `npm run format:check` — checks formatting without writing.
- **Typecheck:** `npm run typecheck` — TypeScript type check without emit.
- **Aggregate gate:** `npm run quality:check` — strict lint + format check + typecheck + unit tests.
- **Docs guardrail:** `npm run docs:check` — local markdown link checks + version parity + `_sections` removed/unsupported drift checks.
- **Security guardrail:** `npm run audit:gate` — fails on new high/critical vulnerabilities not in baseline.

Please run `npm run quality:check`, `npm run docs:check`, and `npm run audit:gate` before opening a PR.

## Tests

- **Unit tests:** `npm test` — runs the unit test suite (core logic: task parsing, folder names, hook resolution).
- **Extension tests (manual):** `npm run test:extension` or the **Run Extension Tests** launch config in VS Code/Cursor.
- The extension-host test flow uses `test-workspace/` as a committed fixture workspace path.

Running these before pushing helps catch regressions.

## Spec system and CLI

- **Spec pipeline:** Requirements → Design → Tasks → Verify. See [AGENTS.md](AGENTS.md) for folder structure, CLI commands, and stage pipeline.
- **Codex integration:** Use `@nspec` commands in VS Code chat (`/spec`, `/status`, `/refine`, `/context`).

## Code quality

- The project uses TypeScript with strict mode. Keep the core (`core/`) and host wiring (`extension.ts`, `specManager.ts`, panel, chat) clearly separated so core logic can be tested without the VS Code runtime.
- For deeper code review guidance, see `.cursor/skills/code-quality-critique/` if present.

## Submitting changes

1. Open an issue or pick an existing one to align scope.
2. Create a branch, make changes, run `npm run quality:check`, `npm run docs:check`, and `npm run audit:gate`.
3. Run the extension via **Run Extension** and manually test the flows you touched.
4. Open a pull request with a short description and, if relevant, a link to the issue.

If you have questions, open an issue or discussion in the repo.
