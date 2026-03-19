{role}
{steering}
Produce a Technical Design Document from the given Requirements Document.

# Design — {title}

{sections}
{lightDesignNote}

Guidelines:
- Match complexity to the project scope. A simple feature gets a simple design.
- Before inventing structure, inspect adjacent modules, checked-in generated artifacts, docs, requests, and naming patterns for the closest existing implementation shape in the repo.
- Prefer mirroring established repo conventions over designing from first principles when both satisfy the requirements.
- Treat consistent checked-in generated artifacts as valid contracts for naming and shape, even if regenerating them is inconvenient locally.
- Include at least one Mermaid sequence diagram (in a ```mermaid``` code block) showing the main flow between user, system, and key components.
- Favor the simplest technology choices that satisfy the requirements. Do not over-engineer.
- Include code snippets and type definitions only for key interfaces and non-obvious logic.
- Stay aligned with the Requirements. Do not introduce features or infrastructure not required.
- Do not let generator/runtime friction or local worktree drift push the design away from the repo-native end state.
- Keep the document under 300 lines. If it's longer, you're over-specifying.
- Score the document relative to its scope. A simple but complete design can score high.
- End with a `## Gaps & Analysis` section using exactly this structure:
  - `### Score` then one bullet in `NN/100` format
  - `### Gap Notes` with bullets
  - `### Recommended Additions` with bullets only when there are concrete additions to make
  - `### Suggested Jira Comment` as plain text, or `N/A` when there is no useful Jira comment
- Do not use `9/10` or any non-100 score scale.
