# Customization Playground

This folder shows practical nSpec customization depth using copy-ready files.

How to use these examples:
1. Copy the file(s) you want into your workspace `.specs/` folder.
2. Regenerate the relevant stage (Requirements, Design, Tasks, Verify).
3. Iterate on wording until output shape is stable.

## Easy customization (low risk, fast)

- Requirements format toggle in panel: `Format: GWT` / `Format: EARS`.
- Workspace steering files in `.specs/steering/*.md`.
- Per-spec steering in `.specs/<name>/_steering.md`.

Why easy: these adjust guidance without replacing the core generation template.

## Medium customization (targeted output shaping)

- Per-spec extra sections in `.specs/<name>/_sections/<stage>.md`.
- Per-spec role override in `.specs/<name>/_role.md`.

Why medium: these can significantly change structure/voice and require testing across stages.

## Advanced customization (full control)

- Full stage prompt override in `.specs/<name>/_prompts/<stage>.md`.
- Workspace-wide override in `.specs/_prompts/<stage>.md`.

Why advanced: this bypasses built-in defaults for that stage. Keep prompts explicit and deterministic.

## Hard / code-level customization (not simple file drops)

- Changing panel UX behavior, action wiring, streaming model, or task orchestration.
- Altering stage pipeline sequencing and command dispatch behavior.

Why hard: requires extension code changes (`src/SpecPanelProvider.ts`, `media/panel.js`, `src/core/prompts.ts`, etc.).

## Included examples in this folder

- Workspace steering: `.specs/steering/product.md`
- Per-spec steering: `.specs/hello-world/_steering.md`
- Per-spec role: `.specs/hello-world/_role.md`
- Per-spec extra sections: `.specs/hello-world/_sections/tasks.md`
- Per-spec full prompt override: `.specs/hello-world/_prompts/design.md`
