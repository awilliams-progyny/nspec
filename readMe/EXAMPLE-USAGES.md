# nSpec Example Usages (Customization First)

Use this as a practical menu: pick a goal, edit files, regenerate, and iterate.

## Runtime note

All examples apply to both extension and CLI.
Defaults differ by runtime surface:

- extension (`lm` mode) default model: `gpt-5.3-codex`
- CLI default model: `gpt-4o`

## Example 1: Team-wide baseline for a TypeScript API

Goal:

- keep outputs aligned with your stack and test standards

Edit:

- `.specs/steering/product.md`
- `.specs/steering/tech.md`
- `.specs/steering/testing.md`

Expected effect:

- requirements/design/tasks reflect your conventions and test strategy

## Example 2: Security-heavy auth spec

Goal:

- bias one spec toward threat modeling and access controls

Edit:

- `.specs/user-auth/_steering.md`
- optional `.specs/user-auth/_role.md` (legacy only)

Expected effect:

- generated stages call out auth boundaries, auditability, and security failure modes

## Example 3: Strict design output for one spec

Goal:

- force design docs to include explicit architecture and flow details

Edit:

- `.specs/user-auth/_prompts/design.md`

Expected effect:

- design output follows your exact structure for that spec

## Example 4: Strict tasks style for all specs

Goal:

- keep tasks dependency-ordered and FR-mapped

Edit:

- `.specs/_prompts/tasks.md`

Expected effect:

- all generated `tasks.md` files follow a common execution contract

## Example 5: Formal requirements style (EARS)

Goal:

- default to formal acceptance criteria

Edit:

- `.specs/config.json`

Example:

```json
{ "requirementsFormat": "ears" }
```

Expected effect:

- requirements generation defaults to EARS unless overridden

## Example 6: Prompt debugging before broad changes

Goal:

- verify actual prompt source and precedence before regeneration

Run:

```bash
node bin/nspec.mjs explain-prompt <name> requirements
node bin/nspec.mjs explain-prompt <name> design
node bin/nspec.mjs lint-customization <name>
```

Expected effect:

- fast visibility into override source and risk areas

## Example 7: Playground onboarding

Goal:

- train contributors without touching production specs

Use:

- `examples/customization-playground/.specs/hello-world/*`
- `examples/customization-playground/.specs/maximal-markdowns/*`

Expected effect:

- contributors learn steering and prompt patterns with low risk

## Example 8: Fast iteration loop

1. Pick one target stage and one customization file.
2. Make a small edit.
3. Regenerate only needed stages.
4. Inspect quality and drift.
5. Repeat.

Tip:

- steering first
- `_role.md` only for legacy compatibility
- `_prompts/<stage>.md` when full control is required
- `_sections` is removed and no longer supported
