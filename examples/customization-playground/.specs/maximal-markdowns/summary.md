# Maximal Markdown Pack

Purpose:
- Provide one place showing the maximum expected markdown files users can author for nSpec customization and stage content.
- Separate workspace-level controls from spec-level controls.
- Make it easy to copy files into active `.specs/` paths.

How to use:
1. Choose only the files needed for your use case.
2. Copy from this pack into real nSpec paths.
3. Prefer steering and role first; use `_prompts` only when you need full stage replacement.

Semantics:
- `steering/*.md`, `_steering.md` => add/merge context.
- `_role.md` => replace role/persona preamble.
- `_prompts/<stage>.md` => full replacement of a stage system prompt.
- stage docs (`requirements.md`, `design.md`, `tasks.md`, `verify.md`) => generated/output content you can edit.

Copy targets:
- `workspace/steering/*.md` -> `.specs/steering/*.md`
- `workspace/_steering.md` -> `.specs/_steering.md`
- `workspace/_role.md` -> `.specs/_role.md`
- `workspace/_prompts/*.md` -> `.specs/_prompts/*.md`
- `spec/*` -> `.specs/<spec-name>/*`

Notes:
- This folder is intentionally not an active spec.
- Non-markdown controls (for example `spec.config.json`) are not included in this pack.
- `_sections` is intentionally excluded; it is no longer supported.
