# nSpec Prompt System

nSpec builds prompts with one shared assembly path used by panel, CLI, and chat.

The model is skills-first:
1. **Steering skills**: persistent project/spec instructions
2. **Stage prompt**: built-in template or full `_prompts` override
3. **Role override (legacy/optional)**: only if you need strict voice/lens control

## File layout

```
src/core/prompts.ts         <- built-in stage templates
src/core/promptAssembly.ts  <- precedence + assembly
src/core/specStore.ts       <- prompt-related file loading

.specs/                     <- workspace-level customization
  config.json               <- defaults (for example requirementsFormat)
  _steering.md              <- optional workspace steering
  _role.md                  <- optional legacy role override (prefer steering skills)
  steering/*.md             <- recommended steering namespace
  _prompts/
    requirements.md         <- optional full stage override
    design.md
    tasks.md
    verify.md

.specs/<name>/              <- spec-level customization (wins over workspace)
  spec.config.json
  _steering.md
  _role.md                  <- optional legacy role override
  _prompts/
    requirements.md
    design.md
    tasks.md
    verify.md
```

## Precedence rules

### Steering skills
- `.specs/steering/*.md` (alphabetical)
- then `.specs/_steering.md`
- then `.specs/<name>/_steering.md`

### Role override (legacy/optional)
- `.specs/<name>/_role.md`
- else `.specs/_role.md`
- else built-in default role

### Stage prompt
- `.specs/<name>/_prompts/<stage>.md`
- else `.specs/_prompts/<stage>.md`
- else built-in stage prompt

### Requirements format
- runtime override (if provided)
- else `spec.config.json`
- else `.specs/config.json`
- else default `given-when-then`

## Example-first customization recipes

### 1) Improve output quality globally (best default)
Goal: better outputs everywhere with minimal risk.

Edit:
- `.specs/steering/product.md`
- `.specs/steering/tech.md`
- `.specs/steering/testing.md`

Effect:
- all stages stay aligned with product constraints, stack, and test expectations.

### 2) Add spec-specific skills for one spec
Goal: make one spec security- or performance-focused.

Edit:
- `.specs/<name>/_steering.md`

Effect:
- same stage templates, but spec-local skills/instructions drive better decisions.

### 3) Enforce strict design format for one spec
Goal: always include specific architecture sections and sequence flow details.

Edit:
- `.specs/<name>/_prompts/design.md`

Effect:
- full replacement of built-in design prompt for that spec.

### 4) Enforce strict task style globally
Goal: keep tasks concise and implementation-ready.

Edit:
- `.specs/_prompts/tasks.md`

Effect:
- all specs get the same task-writing contract.

### 5) Try EARS requirements by default
Goal: formal, testable requirements style.

Edit:
- `.specs/config.json`

Example:
```json
{ "requirementsFormat": "ears" }
```

Effect:
- requirements generation defaults to EARS unless overridden per spec.

### 6) Debug why prompt behavior changed
Goal: explain and validate current prompt assembly before generation.

Run:
```bash
node bin/nspec.mjs explain-prompt <name> <stage>
node bin/nspec.mjs lint-customization [name]
```

Effect:
- `explain-prompt` shows sources and precedence.
- `lint-customization` flags risky overrides or removed mechanisms.

## Recommended path (simple -> advanced)

1. Start with steering files.
2. Add spec-local steering skills when one spec needs special constraints.
3. Use `_role.md` only as legacy/compatibility when steering is not sufficient.
4. Add `_prompts` overrides only when structure/behavior must be fully controlled.
5. Use `explain-prompt` and `lint-customization` before large prompt changes.

## Reference docs

- Customization taxonomy: `readMe/SPEC-TAXONOMY.md`
- Example usage cookbook: `readMe/EXAMPLE-USAGES.md`
- Playground examples: `examples/customization-playground/README.md`
