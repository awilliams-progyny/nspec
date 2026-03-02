# nSpec Example Usages (Customization First)

Use this as a practical menu: pick a goal, edit the listed files, regenerate, then iterate.

## Example 1: Team-wide baseline for a TypeScript API

Goal:
- keep outputs aligned with your stack and test standards.

Edit:
- `.specs/steering/product.md`
- `.specs/steering/tech.md`
- `.specs/steering/testing.md`

Expected effect:
- requirements/design/tasks reflect your API conventions, runtime choices, and test strategy.

## Example 2: Security-heavy auth spec

Goal:
- bias one spec toward threat modeling and access controls.

Edit:
- `.specs/user-auth/_steering.md`
- optional: `.specs/user-auth/_role.md` (legacy/compatibility only)

Expected effect:
- generated requirements/design call out auth boundaries, audit needs, and security failure modes using spec-local skills context.

## Example 3: Strict design output with sequence diagram rules

Goal:
- force design docs to include architecture intent and explicit sequence flow.

Edit:
- `.specs/user-auth/_prompts/design.md`

Expected effect:
- design output follows your exact design template/rules for that spec.

## Example 4: Strict tasks style for all specs

Goal:
- keep tasks dependency-ordered, FR-mapped, and implementation-ready.

Edit:
- `.specs/_prompts/tasks.md`

Expected effect:
- every generated `tasks.md` follows the same strict format across projects.

## Example 5: Formal requirements style (EARS)

Goal:
- default to more formal acceptance criteria.

Edit:
- `.specs/config.json`

Example:
```json
{ "requirementsFormat": "ears" }
```

Expected effect:
- requirements generation uses EARS by default.

## Example 6: Safe prompt debugging before big changes

Goal:
- verify what prompt source actually runs.

Run:
```bash
node bin/nspec.mjs explain-prompt <name> requirements
node bin/nspec.mjs explain-prompt <name> design
node bin/nspec.mjs lint-customization <name>
```

Expected effect:
- fast visibility into precedence and override impact before regeneration.

## Example 7: Playground-driven onboarding for new contributors

Goal:
- teach customization without touching production specs.

Use:
- `examples/customization-playground/.specs/hello-world/*`
- `examples/customization-playground/.specs/maximal-markdowns/*`

Expected effect:
- contributors learn steering-skills and prompt patterns with low risk.

## Example 8: Fast iteration loop (example-first)

1. Pick a target stage and one customization file.
2. Make a small change.
3. Regenerate only needed stages.
4. Inspect output quality.
5. Repeat until stable.

Tip:
- prefer steering skills first.
- use `_role.md` only for legacy compatibility.
- use `_prompts/<stage>.md` only when you need full control.
