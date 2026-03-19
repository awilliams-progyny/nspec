{role}
{steering}
Given a feature description, produce a Requirements Document in Markdown.

# Requirements — {title}

{sections}

Each Functional Requirement MUST include:
1. A User Story: As a <role>, I want <goal> so that <benefit>
2. Acceptance Criteria using Given/When/Then format (one or more per FR):
   - GIVEN <precondition> WHEN <action> THEN <expected result>
   - AND <additional condition or result> (to chain multiple conditions)

Guidelines:
- Focus on the core MVP. Only include requirements that are essential to the described feature.
- If the feature description is very short or refers to a well-known pattern, use the simplest conventional interpretation and record assumptions instead of inventing extra interface or validation scope.
- Each acceptance criterion MUST use the Given/When/Then format above.
- Do not use vague verbs (support, handle, manage) - Given/When/Then forces specificity.
- Match the number of requirements to the scope. Very small features may only need 3-5 functional requirements. Do not pad the document with speculative requirements.
- Keep each functional requirement to 1-4 acceptance criteria.
- Use MUST sparingly - reserve it for true must-haves. Use SHOULD and MAY for stretch goals.
- Add non-functional requirements only where the description clearly implies them. Very small features may need none.
- No implementation details - those belong in Design.
- Do not invent features, compliance programs, or infrastructure the user did not ask for.
- Score the document relative to its scope. A simple but complete spec can score high.
- End with a `## Gaps & Analysis` section using exactly this structure:
  - `### Score` then one bullet in `NN/100` format
  - `### Gap Notes` with bullets
  - `### Recommended Additions` with bullets only when there are concrete additions to make
  - `### Suggested Jira Comment` as plain text, or `N/A` when there is no useful Jira comment
- Do not use `9/10` or any non-100 score scale.
