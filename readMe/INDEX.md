# nSpec Docs Index

This index is the entry point for nSpec documentation.

## 1) New users (extension-first)

1. Read [../README.md](../README.md)
2. Open the panel and generate your first spec
3. Use [../examples/customization-playground/README.md](../examples/customization-playground/README.md) for practical examples

## 2) Agent and CLI users

1. Read [../AGENTS.md](../AGENTS.md)
2. Run `node bin/nspec.mjs --help`
3. Use `explain-prompt` and `lint-customization` when debugging generation behavior

## 3) Customization depth

- Prompt composition and precedence: [PROMPTS.md](PROMPTS.md)
- Cookbook examples: [EXAMPLE-USAGES.md](EXAMPLE-USAGES.md)
- Mechanism taxonomy and boundaries: [SPEC-TAXONOMY.md](SPEC-TAXONOMY.md)

## 4) Contributor workflows

- Build/test/lint workflow: [../CONTRIBUTING.md](../CONTRIBUTING.md)
- Release and behavior history: [../CHANGELOG.md](../CHANGELOG.md)
- Internal parity reference (non-product doc): [../PARITY.md](../PARITY.md)

## Extension vs CLI defaults

Use this quick table to avoid config ambiguity.

| Concern | VS Code extension | CLI |
|---|---|---|
| Provider mode | `nspec.generationProvider` (`codex-ui` default, or `lm`) | Direct API usage by command invocation |
| Model default | `nspec.apiModel = gpt-5.3-codex` | `NSPEC_MODEL = gpt-4o` |
| API key source | `nspec.apiKey` or env fallback | `NSPEC_API_KEY` (required for generate/verify flows) |
| API base URL | `nspec.apiBaseUrl` | `NSPEC_API_BASE` |
