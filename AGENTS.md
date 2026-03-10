# nSpec — Agent Instructions

This file is the contract for coding agents working with nSpec specs and CLI workflows.

## What nSpec Does

nSpec is a spec-first workflow:

```text
Requirements -> Design -> Tasks -> Verify
```

Each spec is stored as markdown under `.specs/<name>/`.

## Folder Structure

```text
.specs/
├── <spec-name>/
│   ├── spec.config.json
│   ├── requirements.md
│   ├── design.md
│   ├── tasks.md
│   ├── verify.md
│   ├── _progress.json
│   ├── _steering.md            (optional)
│   ├── _role.md                (optional, legacy)
│   └── _prompts/
│       ├── requirements.md     (optional)
│       ├── design.md
│       ├── tasks.md
│       └── verify.md
├── steering/                   (optional, workspace-wide)
│   ├── product.md
│   ├── tech.md
│   ├── structure.md
│   └── testing.md
├── _steering.md                (optional, workspace-wide legacy)
├── _role.md                    (optional, workspace-wide legacy)
└── _prompts/                   (optional, workspace-wide)
```

## Runtime Paths (Important)

### VS Code extension path

- Default provider mode: `codex-ui`
- Alternate mode: `lm`
- Extension settings are under `nspec.*` in VS Code settings.
- Extension model default (lm mode): `nspec.apiModel = gpt-5.3-codex`

### CLI path

- Entry: `node bin/nspec.mjs`
- Uses environment variables (`NSPEC_API_KEY`, `NSPEC_API_BASE`, `NSPEC_MODEL`, `NSPEC_SPECS_DIR`)
- CLI model default: `NSPEC_MODEL = gpt-4o`

Do not assume extension defaults and CLI defaults are the same.

## CLI Commands

### Core spec lifecycle

```bash
nspec init <name> [--type bugfix] [--mode design-first] [--template <id>] [--format ears]
nspec generate <name> <stage> --description "..."
nspec verify <name> [--scheme audit|cove|committee]
nspec cascade <name> [--from <stage>]
nspec status [name]
nspec refine <name> <stage> --feedback "..."
nspec import <name> <stage> <file> [--transform]
nspec backfill <name> requirements
```

### Bugfix pipeline helpers

```bash
nspec bugfix-generate <name> <stage>
nspec bugfix-cascade <name> [--from <stage>]
```

### Support utilities

```bash
nspec templates
nspec hooks <list|run> [hook-name]
nspec vibe-to-spec <name> [--transcript <file>|-] [--cascade]
nspec check-tasks <name>
nspec explain-prompt <name> <stage>
nspec lint-customization [name]
nspec setup-steering
nspec setup-agents
nspec config [get|set <key> <value>]
```

## Stage Pipeline

| Stage | Input | Output |
|---|---|---|
| requirements | feature description | FRs, NFRs, constraints |
| design | requirements.md | architecture and components |
| tasks | design.md | ordered implementation checklist |
| verify | requirements + design + tasks | health score + coverage + gaps |

## CLI vs Direct Edit

| Action | Recommended approach |
|---|---|
| Generate a new stage | CLI (`generate`) |
| Generate downstream stages | CLI (`cascade`) |
| Verify coverage/quality | CLI (`verify`) |
| Small wording correction | direct markdown edit |
| Requirement structure change | edit upstream then regenerate downstream |
| Question/clarification on stage | `refine --feedback` |
| Import PRD/Notion export | `import --transform` |

## Importing Existing Documents

Typical import flow:

1. `nspec import <name> requirements <file> --transform`
2. `nspec import <name> design <file>`
3. `nspec cascade <name>`

## Verify-Driven Gap Fixing

When verify shows gaps:

1. Inspect health score and uncovered FRs.
2. Edit upstream (`requirements.md` or `design.md`).
3. Regenerate downstream (`cascade --from design` or later).
4. Re-run `verify`.

## Customization Mechanisms

Preferred order:

1. steering files (`.specs/steering/*.md`)
2. spec-local steering (`.specs/<name>/_steering.md`)
3. `_role.md` only as legacy fallback
4. `_prompts/<stage>.md` when full stage control is required

`_sections` is removed and no longer supported.

## Steering Precedence

Steering merge order:

1. `.specs/steering/*.md` (alphabetical)
2. `.specs/_steering.md`
3. `.specs/<name>/_steering.md`

Role precedence:

1. `.specs/<name>/_role.md`
2. `.specs/_role.md`
3. built-in role

Prompt precedence:

1. `.specs/<name>/_prompts/<stage>.md`
2. `.specs/_prompts/<stage>.md`
3. built-in stage prompt

## Environment Variables (CLI)

| Variable | Default | Purpose |
|---|---|---|
| `NSPEC_API_KEY` | required | API key for generation flows |
| `NSPEC_API_BASE` | `https://api.openai.com/v1` | API base URL |
| `NSPEC_MODEL` | `gpt-4o` | model ID |
| `NSPEC_SPECS_DIR` | `.specs` | specs folder path |

## Vibe-to-Spec Workflow

```bash
# from file
nspec vibe-to-spec auth-feature --transcript chat.md

# from stdin
cat chat.md | nspec vibe-to-spec auth-feature

# generate downstream stages automatically
nspec vibe-to-spec auth-feature --transcript chat.md --cascade
```

## VS Code Integration Notes

- In `codex-ui` mode, stage files are edited through Codex/ChatGPT command workflows.
- In `lm` mode, nSpec calls APIs directly through `LMClient`.
- Supervised task execution uses nSpec tool-call changes (`writeFile`, `editFile`, `runCommand`) with VS Code diff review and explicit accept/reject.

## codex-ui Stage Contract

When using `codex-ui`, each target stage starts with:

```md
<!-- nspec:
stage: requirements|design|tasks|verify
step_id: <opaque id>
done: false
-->
```

Rules:

1. Edit the target stage file in place.
2. Keep the header at the top.
3. Preserve `stage` and `step_id` exactly.
4. Set `done: true` when complete.
5. Stage file content is the source of truth.

## Related Docs

- [README.md](README.md)
- [readMe/INDEX.md](readMe/INDEX.md)
- [readMe/PROMPTS.md](readMe/PROMPTS.md)
- [readMe/EXAMPLE-USAGES.md](readMe/EXAMPLE-USAGES.md)
- [readMe/SPEC-TAXONOMY.md](readMe/SPEC-TAXONOMY.md)
