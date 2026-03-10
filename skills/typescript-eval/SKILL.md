---
name: typescript-eval
description: Test TypeScript code snippets before persisting as skills
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🧪"
  vellum:
    display-name: "TypeScript Evaluation"
    user-invocable: false
---

# TypeScript Evaluation

When you need to test a TypeScript snippet before persisting it as a managed skill, use `bash` directly.

## Workflow

### 1. Write the snippet to a temp file

```
bash command="mkdir -p /tmp/vellum-eval && cat > /tmp/vellum-eval/snippet.ts << 'SNIPPET_EOF'
<your code here>
SNIPPET_EOF"
```

### 2. Run it with bun

```
bash command="bun run /tmp/vellum-eval/snippet.ts" timeout_seconds=10
```

### 3. For function-based testing

If the snippet exports a `default` or `run` function, write a runner script:

```
bash command="cat > /tmp/vellum-eval/runner.ts << 'RUNNER_EOF'
import * as mod from './snippet.ts';
const fn = (mod as any).default ?? (mod as any).run;
const input = {}; // mock input
const result = await fn(input);
console.log(JSON.stringify(result, null, 2));
RUNNER_EOF"
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
