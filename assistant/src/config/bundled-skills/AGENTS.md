# Bundled Skills — Agent Instructions

## Registering Tool Executors

When you add a new tool executor to a bundled skill's `TOOLS.json`, you **must** also register it in `assistant/src/config/bundled-tool-registry.ts`. Each new executor needs two things:

1. **A static import** at the top of the file, grouped under the skill's section comment.
2. **A registry entry** in the `bundledToolRegistry` map.

### Example (settings skill)

```ts
// ── settings ───────────────────────────────────────────────────────────────────
import * as avatarUpdate from "./bundled-skills/settings/tools/avatar-update.js";
// ... other imports ...

export const bundledToolRegistry = new Map<string, SkillToolScript>([
  // settings
  ["settings:tools/avatar-update.ts", avatarUpdate],
  // ... other entries ...
]);
```

The map key format is `skillDirBasename:executorPath` (e.g. `settings:tools/avatar-update.ts`).

### Why this is required

`knip` (`lint:unused`) flags dynamically-loaded executor files as unused exports unless they have a static import somewhere in the dependency graph. The registry provides that static import while also enabling the compiled Bun binary to bundle the scripts (since dynamic imports from the filesystem don't work inside `/$bunfs/`).

You can regenerate the full registry with:

```sh
bun run scripts/generate-bundled-tool-registry.ts
```
