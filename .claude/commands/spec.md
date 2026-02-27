Generate a nSpec spec from this conversation.

The user wants to convert the current discussion into a formal specification pipeline (requirements, design, tasks, verify).

Spec name: $ARGUMENTS (if empty, infer a kebab-case name from the conversation topic)

## Instructions

1. Determine the spec name:
   - If the user provided a name via $ARGUMENTS, use it as-is
   - Otherwise, infer a short kebab-case name from the main topic (e.g., "oauth-login", "notification-system")

2. Pipe the conversation transcript below to the nSpec CLI via stdin:

```
echo '{{CONVERSATION}}' | node bin/nspec.mjs vibe-to-spec <SPEC_NAME> --cascade
```

Replace `<SPEC_NAME>` with the determined name.

3. After the command completes successfully:
   - Read `.specs/<SPEC_NAME>/verify.md` and report the health score
   - Summarize the key requirements that were extracted
   - If the health score is below 80, suggest running `node bin/nspec.mjs refine <SPEC_NAME> requirements --feedback "..."` to address gaps

4. If the command fails with "NSPEC_API_KEY env var is required":
   - Tell the user to set the environment variable: `export NSPEC_API_KEY="your-key"`
   - Mention they can use OpenAI or Anthropic keys
