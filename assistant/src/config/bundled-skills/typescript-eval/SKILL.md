---
name: "TypeScript Evaluation"
description: "Test TypeScript code snippets before persisting as skills"
user-invocable: false
metadata: {"vellum": {"emoji": "🧪"}}
---

# TypeScript Evaluation

When you need to test a TypeScript snippet before persisting it as a managed skill, use `file_write` and `bash` directly.

## Workflow

### 1. Write the snippet to a temp file

```
file_write path=/tmp/vellum-eval/snippet.ts content="<your code here>"
```

### 2. Run it with bun

```
bash command="bun run /tmp/vellum-eval/snippet.ts" timeout_seconds=10
```

### 3. For function-based testing

If the snippet exports a `default` or `run` function, write a runner script:

```
file_write path=/tmp/vellum-eval/runner.ts content="
import fn from './snippet.ts';
const input = {}; // mock input
const result = await fn(input);
console.log(JSON.stringify(result, null, 2));
"
```

Then run the runner:

```
bash command="bun run /tmp/vellum-eval/runner.ts" timeout_seconds=10
```

### 4. Clean up

```
bash command="rm -rf /tmp/vellum-eval/"
```

## Guidelines

- **Iteration limit:** Max 3 attempts before asking the user for guidance.
- **After successful test:** Persist with `scaffold_managed_skill` only after explicit user consent.
- **Timeout:** Use `timeout_seconds=10` (or up to 20 for complex snippets).
- **Error handling:** Read stdout/stderr from the bash output to diagnose failures.
- **Never persist or delete skills without explicit user confirmation.**
