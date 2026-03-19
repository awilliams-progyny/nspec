# nSpec

> Spec-driven development for VS Code and agent workflows.
> Build traceable `Requirements -> Design -> Tasks -> Verify` specs before implementation.

[![Version](https://img.shields.io/badge/version-0.5.0-blue)](https://github.com/nspec/nSpec/releases)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.93.0-007ACC)](https://marketplace.visualstudio.com/items?itemName=awilliams.nSpec)
[![License: MIT](https://img.shields.io/badge/License-MIT-green)](LICENSE)

## Start Here

nSpec gives you a structured spec pipeline before code execution:

```text
Description -> Requirements -> Design -> Tasks -> Verify
```

Use the extension when you want guided panel workflows and supervised diffs.
Use the CLI when you want agent/script-driven generation and automation.

## Install

### From VSIX

1. Open VS Code.
2. Go to Extensions -> `...` -> **Install from VSIX**.
3. Select `nSpec-*.vsix`.

### From Source

```bash
git clone https://github.com/nspec/nSpec.git
cd nSpec
npm install
npm run package
```

## Choose Provider (Extension)

nSpec extension supports two generation providers:

- `codex-ui` (default): Uses Codex/ChatGPT command integration from `openai.chatgpt`.
- `lm`: Uses direct API calls through nSpec settings (`nspec.apiKey`, `nspec.apiBaseUrl`, `nspec.apiModel`).

### Extension defaults

| Setting | Default |
|---|---|
| `nspec.generationProvider` | `codex-ui` |
| `nspec.apiBaseUrl` | `https://api.openai.com/v1` |
| `nspec.apiModel` | `gpt-5.3-codex` |

If you use `lm`, set `nspec.apiKey` (or `NSPEC_API_KEY` / `OPENAI_API_KEY`).

## Quick Happy Path

1. Open panel: `Ctrl+Shift+K` / `Cmd+Shift+K`.
2. Run **nSpec: New Spec**.
3. Provide spec name + description.
4. Generate requirements, then cascade.
5. Review the verify verdict, recommended additions, and gap report.
6. Run tasks in supervised mode with diff review.

## CLI Quick Path

CLI command entrypoint:

```bash
node bin/nspec.mjs
```

Common flow:

```bash
node bin/nspec.mjs init user-auth
node bin/nspec.mjs generate user-auth requirements --description "Add GitHub OAuth"
node bin/nspec.mjs cascade user-auth
node bin/nspec.mjs verify user-auth
node bin/nspec.mjs status user-auth
```

### CLI environment defaults

| Variable | Default |
|---|---|
| `NSPEC_API_BASE` | `https://api.openai.com/v1` |
| `NSPEC_MODEL` | `gpt-4o` |
| `NSPEC_SPECS_DIR` | `.specs` |

`NSPEC_API_KEY` is required for CLI generation, cascade, and refine flows. It is not required for `nspec verify`.

## Customization (Current Support)

Supported customization layers:

- `.specs/steering/*.md`
- `.specs/_steering.md`
- `.specs/<name>/_steering.md`
- `.specs/_prompts/<stage>.md`
- `.specs/<name>/_prompts/<stage>.md`
- `_role.md` as a legacy fallback

`_sections` is removed and no longer supported.

## Quality Gates

Local quality scripts:

- `npm run lint:strict`
- `npm run quality:check`
- `npm run docs:check`
- `npm run audit:gate`

Manual extension-host validation:

- `npm run test:extension`
- VS Code launch config: **Run Extension**

## Troubleshooting

| Symptom | Action |
|---|---|
| codex-ui cannot generate | Run **nSpec: Diagnose Codex Models** and verify `openai.chatgpt` is installed/enabled |
| lm provider fails auth | Set `nspec.apiKey` or `NSPEC_API_KEY` |
| CLI says API key required | Export `NSPEC_API_KEY` before running generate/cascade/refine |
| Stage appears stuck in codex-ui | Ensure nspec header stays intact and `done: true` is set |
| Task checkbox state changed after regeneration | `_progress.json` is the source of persisted task state |

## Documentation Map

- Entry index: [readMe/INDEX.md](readMe/INDEX.md)
- Agent/CLI contract: [AGENTS.md](AGENTS.md)
- Prompt system: [readMe/PROMPTS.md](readMe/PROMPTS.md)
- Example usage: [readMe/EXAMPLE-USAGES.md](readMe/EXAMPLE-USAGES.md)
- Customization taxonomy: [readMe/SPEC-TAXONOMY.md](readMe/SPEC-TAXONOMY.md)
- Playground examples: [examples/customization-playground/README.md](examples/customization-playground/README.md)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)
- Changelog: [CHANGELOG.md](CHANGELOG.md)

## Security

- Never commit API keys.
- `.env`, `.env.*`, and local secret files are ignored by default.
- Supervised task execution requires explicit approval for commands outside `nspec.allowedCommands`.
