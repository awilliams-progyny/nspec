# nSpec Prompt System

The four pipeline stages (Requirements, Design, Tasks, Verify) are driven by
composable system prompts assembled at runtime from:

1. **Role** -- who the AI is
2. **Steering** -- domain context for the project
3. **Sections** -- what to include in the output
4. **Template** -- concise instructions tying it together

## File layout

```
src/core/prompts.ts     <- templates, defaults, assembly engine
src/prompts.ts          <- re-exports from core/prompts.ts (backwards compat)

.specs/                  <- workspace-wide overrides
  _steering.md          <- domain context for all specs
  _role.md              <- role override for all specs
  _prompts/             <- full prompt overrides per stage

.specs/<name>/           <- spec-specific overrides (win over workspace)
  _steering.md          <- domain context for this spec
  _role.md              <- role override for this spec
  _sections/
    requirements.md     <- extra sections (one per line)
    design.md
    tasks.md
    verify.md
  _prompts/             <- full prompt overrides (bypass assembly entirely)
    requirements.md
    design.md
    tasks.md
    verify.md
```

## How assembly works

```
buildSystemPrompt(stage, context)
  |
  +--> template[stage]           # concise core instructions
  |     |
  |     +--> {role}              # "You are a..." (default or _role.md)
  |     +--> {steering}          # domain context (from _steering.md)
  |     +--> {sections}          # section list (defaults + _sections/*.md)
  |     +--> {title}             # spec name
  |
  +--> OR _prompts/stage.md      # full override, skips assembly
```

## Defaults

### Role
```
You are a senior software architect practising spec-driven development.
```
Override by creating `_role.md` with any content. Examples:
- `You are a game designer specializing in educational children's games.`
- `You are a security engineer with expertise in authentication systems.`

### Sections (per stage)

**Requirements:** Overview, Functional Requirements, Non-Functional Requirements, Constraints & Assumptions

**Design:** Overview, Architecture, Component Breakdown, Data Models, Technology Choices

**Tasks:** (no sections -- uses checkbox list format)

**Verify:** Spec Health Score, Coverage Matrix, Gap Report, Recommended Additions, Verdict

Add more by creating `_sections/requirements.md` etc, one line per section:
```
Glossary
User Stories
Regulatory Compliance
```

### Steering

Steering provides domain context injected into every prompt. It shapes the AI's
understanding without prescribing output structure.

Example `_steering.md`:
```
This is a browser-based casual game for ages 8-14.
Stack: React + TypeScript, deployed on Vercel.
No backend -- all state is client-side.
Key constraint: must work offline after initial load.
```

Workspace-wide and spec-specific steering are concatenated (both apply).

## Tuning workflow

```bash
# 1. Edit src/prompts.ts (templates, default sections)
# 2. Compile
npm run compile

# 3. Run the harness
node test-harness.mjs --spec "My Feature" --prompt "Description..." --tag v1

# 4. Review output
cat .harness-runs/v1-*/_scorecard.md
cat .harness-runs/v1-*/verify.md

# 5. Tweak prompts, run again
node test-harness.mjs --spec "My Feature" --prompt "Description..." --tag v2

# 6. Compare
diff -r .harness-runs/v1-* .harness-runs/v2-*
```

The harness saves the exact prompts sent to the AI in `_prompts/` so you can
see precisely what changed between runs.

## Growth path

The system is designed to start minimal and grow per-spec:

1. **Start here:** Just use `--prompt` with the harness. Default role, no steering.
2. **Add steering:** Drop `_steering.md` when you need domain context.
3. **Add sections:** Drop `_sections/requirements.md` when defaults miss something.
4. **Override role:** Drop `_role.md` when the domain needs a different persona.
5. **Full override:** Drop `_prompts/requirements.md` to bypass assembly entirely.

Each level adds specificity without touching the core templates.
