Show the status of nSpec specs in this project.

## Instructions

If the user provided a spec name via $ARGUMENTS, show detail for that spec:

```
node bin/nspec.mjs status $ARGUMENTS
```

Otherwise, show the overview of all specs:

```
node bin/nspec.mjs status
```

After running the command, present the results clearly. If a spec has a verify.md, read it and include the health score.
