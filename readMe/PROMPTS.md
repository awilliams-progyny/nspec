# nSpec Prompt System

nSpec uses a shared prompt assembly path for panel, CLI, and chat generation.

## Runtime surfaces (extension vs CLI)

This doc describes prompt assembly behavior, which is shared.
Provider defaults differ by runtime surface:

| Surface | Provider/defaults |
|---|---|
| VS Code extension | `codex-ui` default provider, `lm` optional; `nspec.apiModel` default `gpt-5.3-codex` |
| CLI | direct command execution via `node bin/nspec.mjs`; `NSPEC_MODEL` default `gpt-4o` |

## File layout

```text
src/core/prompts.ts         built-in stage templates
src/core/promptAssembly.ts  precedence + assembly
src/core/specStore.ts       prompt-related file loading

.specs/                     workspace-level customization
  config.json               defaults (for example requirementsFormat)
  _steering.md              optional workspace steering (legacy form)
  _role.md                  optional legacy role override
  steering/*.md             recommended steering namespace
  _prompts/
    requirements.md         optional full stage override
    design.md
    tasks.md
    verify.md

.specs/<name>/              spec-level customization (wins over workspace)
  spec.config.json
  _steering.md
  _role.md                  optional legacy role override
  _prompts/
    requirements.md
    design.md
    tasks.md
    verify.md
```

## Precedence rules

### Steering skills

1. `.specs/steering/*.md` (alphabetical)
2. `.specs/_steering.md`
3. `.specs/<name>/_steering.md`

### Role override (legacy/optional)

1. `.specs/<name>/_role.md`
2. `.specs/_role.md`
3. built-in default role

### Stage prompt

1. `.specs/<name>/_prompts/<stage>.md`
2. `.specs/_prompts/<stage>.md`
3. built-in stage prompt

### Requirements format

1. runtime override (if provided)
2. `<spec>/spec.config.json`
3. `.specs/config.json`
4. default `given-when-then`

## Supported customization mechanisms

Supported now:

- steering files
- `_role.md` (legacy fallback)
- `_prompts/<stage>.md` full overrides

`_sections` is removed and no longer supported.

## Example-first customization recipes

### Improve output quality globally

Edit:

- `.specs/steering/product.md`
- `.specs/steering/tech.md`
- `.specs/steering/testing.md`

### Add spec-specific context

Edit:

- `.specs/<name>/_steering.md`

### Enforce strict design output for one spec

Edit:

- `.specs/<name>/_prompts/design.md`

### Enforce strict tasks style globally

Edit:

- `.specs/_prompts/tasks.md`

### Set EARS as requirements default

Edit `.specs/config.json`:

```json
{ "requirementsFormat": "ears" }
```

### Debug prompt source and precedence

```bash
node bin/nspec.mjs explain-prompt <name> <stage>
node bin/nspec.mjs lint-customization [name]
```

## Recommended path

1. Start with steering files.
2. Add spec-local steering when needed.
3. Use `_role.md` only for legacy compatibility.
4. Use `_prompts` overrides for full stage control.
5. Use `explain-prompt` and `lint-customization` before large prompt changes.

## Reference docs

- [INDEX.md](INDEX.md)
- [EXAMPLE-USAGES.md](EXAMPLE-USAGES.md)
- [SPEC-TAXONOMY.md](SPEC-TAXONOMY.md)
- [../examples/customization-playground/README.md](../examples/customization-playground/README.md)
