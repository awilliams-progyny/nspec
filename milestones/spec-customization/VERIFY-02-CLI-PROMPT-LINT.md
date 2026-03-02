# Verification 02: CLI Explainability and Lint Commands

Date: 2026-03-02

## Method

Validated new CLI commands added by the plan:
- `explain-prompt`
- `lint-customization`

## Commands

```bash
node bin/nspec.mjs explain-prompt hello-world requirements --specs-dir examples/customization-playground/.specs
node bin/nspec.mjs lint-customization --specs-dir examples/customization-playground/.specs
```

## Results

1. `explain-prompt`:
- `explain_exit=0`
- Reported expected source map details:
  - Base template: `requirements`
  - Spec config source present
  - Steering sources detected
  - Role source detected
  - No prompt override for requirements
  - Mechanisms: `merge:steering, replace:role`

2. `lint-customization`:
- `lint_exit=0`
- Reported expected warning from playground fixture:
  - `PROMPT_FULL_OVERRIDE` for `.specs/hello-world/_prompts/design.md`

## Conclusion

Both new CLI commands are functional and produce expected diagnostics.
