Refine a nSpec spec stage based on this conversation.

Usage: /spec-refine <spec-name> <stage>
Example: /spec-refine auth-feature requirements

Arguments from $ARGUMENTS should be: <spec-name> <stage>
Valid stages: requirements, design, tasks, verify

## Instructions

1. Parse $ARGUMENTS to extract the spec name and stage.

2. Read the conversation below to understand what feedback the user is providing:

{{CONVERSATION}}

3. Extract the specific feedback or change request from the conversation. Focus on:
   - What the user wants added, changed, or removed
   - Any new constraints or requirements mentioned
   - Corrections to existing content

4. Run the refine command with the extracted feedback:

```
node bin/nspec.mjs refine <SPEC_NAME> <STAGE> --feedback "<extracted feedback>"
```

5. After refinement:
   - If downstream stages exist, suggest running `node bin/nspec.mjs cascade <SPEC_NAME> --from <NEXT_STAGE>` to propagate changes
   - Show what changed in the refined stage
