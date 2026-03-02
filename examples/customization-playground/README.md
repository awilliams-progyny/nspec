# Customization Playground

This folder is the fastest way to learn nSpec customization through concrete examples.

## Start here

1. Open [Prompt System Guide](../../readMe/PROMPTS.md)
2. Open [Example Usages](../../readMe/EXAMPLE-USAGES.md)
3. Copy one example file into your real `.specs/` folder
4. Regenerate the relevant stage
5. Evaluate output and iterate

## What this folder contains

- `/.specs/hello-world/`:
  - a small, practical customization set you can copy directly
- `/.specs/maximal-markdowns/`:
  - a “maximum expected markdowns” reference pack
  - includes workspace-level and spec-level examples

## Recommended learning order

1. `steering/*.md` (context)
2. `_steering.md` (spec-local context)
3. `_prompts/<stage>.md` (full stage control)
4. `_role.md` (legacy/compatibility only)

## Usage notes

- Steering skills are usually enough for most teams.
- `_prompts/<stage>.md` is powerful but higher-maintenance.
- `_role.md` is optional legacy compatibility when steering is not enough.
- Use `explain-prompt` and `lint-customization` when behavior is unclear.

## Included examples in this folder

- Workspace steering: `.specs/steering/product.md`
- Per-spec steering: `.specs/hello-world/_steering.md`
- Per-spec role: `.specs/hello-world/_role.md`
- Per-spec full prompt override: `.specs/hello-world/_prompts/design.md`
