# Verification 03: `_sections` Removal Enforcement

Date: 2026-03-02

## Method

Verified `_sections` removal in three ways:
1. Runtime code search for old `_sections` composition hooks
2. Positive lint failure when `_sections` exists
3. Project search to confirm remaining `_sections` mentions are only enforcement/docs context

## Checks

### 1) Legacy hook removal

```bash
rg -n "loadExtraSections|extraSections" src bin
```

Result:
- No matches (`rg_exit=1`), which is expected for zero-match search.

### 2) Lint hard-fail on `_sections`

Fixture command:

```bash
tmpdir=$(mktemp -d /tmp/nspec-lint-XXXXXX)
mkdir -p "$tmpdir/demo/_sections"
cat > "$tmpdir/demo/_sections/tasks.md" <<'DOC'
Extra section
DOC
node bin/nspec.mjs lint-customization --specs-dir "$tmpdir"
```

Result:
- Lint output: `ERROR [SECTIONS_REMOVED] ...`
- Exit code: `lint_sections_exit=1`

### 3) Scope of remaining references

```bash
rg -n "_sections" src README.md AGENTS.md examples bin/nspec.mjs
```

Result:
- Runtime references only in `bin/nspec.mjs` lint enforcement logic.
- Documentation references only explain that `_sections` is removed.
- No active `_sections` customization examples remain.

## Conclusion

`_sections` is removed from runtime customization behavior and actively blocked by lint.
