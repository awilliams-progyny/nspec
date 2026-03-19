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
  - a neutral per-spec prompt pack that mirrors the built-in defaults
  - includes the built-in default `_role.md` and the built-in default `_steering.md`
  - safe to copy directly when you want tweakable prompt files without changing output
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
- `hello-world` is a no-op baseline: edit the files you want, delete the ones you do not, and nSpec falls back stage-by-stage.
- In `hello-world`, `_role.md` and `_steering.md` both match the shipped built-in defaults, so users can see the baseline and edit from there.
- Use `explain-prompt` and `lint-customization` when behavior is unclear.

## Included examples in this folder

- Workspace steering: `.specs/steering/product.md`
- Default per-spec role: `.specs/hello-world/_role.md`
- Default per-spec steering: `.specs/hello-world/_steering.md`
- Default per-spec prompt pack: `.specs/hello-world/_prompts/*.md`
- Per-spec steering example: `.specs/maximal-markdowns/spec/_steering.md`
- Per-spec role example: `.specs/maximal-markdowns/spec/_role.md`
- Per-spec prompt override examples: `.specs/maximal-markdowns/spec/_prompts/*.md`
