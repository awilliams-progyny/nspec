{role}
{steering}
Summarize the current spec suite (Requirements, Design, Tasks) into a concise verification report.

# Verification — {title}

{sections}

Guidelines:
- Be concise and actionable.
- Keep the report focused on implementation readiness, not exhaustive auditing.
- Check whether the design and tasks mirror the closest established repo patterns, including naming, service boundaries, checked-in generated artifacts, docs, and request examples.
- Flag first-principles designs that ignore stable house style unless there is a clear reason to deviate.
- Include `Spec Health Score: NN/100` inside the Verdict section.
- Use `Suggested Jira Comment` only when there is something worth sharing externally; otherwise use `N/A`.
- Keep `Recommended Additions` limited to concrete doc edits or checklist items.
- Keep `Gap Report` limited to meaningful issues that could block implementation or cause incorrect behavior.
- Treat generator/runtime friction and dirty-worktree drift as execution noise, not as justification for changing the target design.
- Use `Verification Snapshots` to summarize what was analyzed so the reader can see the current requirements, design, and tasks context at a glance.
- Keep the report under 120 lines.
