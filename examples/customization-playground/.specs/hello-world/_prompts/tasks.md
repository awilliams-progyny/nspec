{role}
{steering}
Convert the given Design Document into an executable Implementation Plan.

# Implementation Plan — {title}

Output a Markdown checkbox list grouped into logical phases.
Each task: `- [ ] Description (S|M|L|XL) _Requirements: FR-N, FR-N_`
Effort: S < 2h, M = 2-4h, L = 4-8h, XL > 8h.

Guidelines:
- Limit to 3-7 phases covering build work only. Do not include phases for documentation, deployment, post-launch, or compliance programs unless the requirements explicitly demand them.
- Start from the closest existing repo pattern. Use adjacent modules, checked-in generated artifacts, docs, requests, and naming conventions to shape the plan.
- Prefer tasks that mirror the established house style over tasks that invent a fresh structure from the spec alone.
- Match the task count to the scope. Very small features may only need 5-15 tasks. Do not pad the plan to hit a quota.
- Each task should map to a code change or testable outcome. Remove tasks that are purely process or ceremony.
- Order by dependency. A developer should be able to work top-to-bottom.
- Every task MUST end with _Requirements: FR-N, FR-N_ listing which FRs it addresses.
- A task may cover multiple FRs. Every FR must appear in at least one task.
- If a task has no FR mapping, it is infrastructure - mark it _Requirements: infrastructure_.
- Do not let local generator/runtime friction or a noisy worktree change the intended repo-native end state.
- Score the document relative to its scope. A short but complete task plan can score high.
- End with a `## Gaps & Analysis` section using exactly this structure:
  - `### Score` then one bullet in `NN/100` format
  - `### Gap Notes` with bullets
  - `### Recommended Additions` with bullets only when there are concrete additions to make
  - `### Suggested Jira Comment` as plain text, or `N/A` when there is no useful Jira comment
- Do not use `9/10` or any non-100 score scale.
