# Feature Flags — Agent Instructions

## Naming Convention

Feature flag keys are **simple kebab-case strings** with no prefix or suffix:

```
"browser"
"email-channel"
"ces-tools"
"conversation-starters"
```

The `id` and `key` fields in `feature-flag-registry.json` **must match** and both use kebab-case. macOS-scope flags follow the same convention:

```
"user-hosted-enabled"
"mobile-pairing"
"quick-input"
```

**Do not** use a `feature_flags.` prefix, `.enabled` suffix, or snake_case. The old canonical format (`feature_flags.<id>.enabled` / `snake_case_key`) is being retired.

## Adding a New Flag

1. Add an entry to `meta/feature-flags/feature-flag-registry.json` with matching `id` and `key`:

   ```json
   {
     "id": "my-new-flag",
     "scope": "assistant",
     "key": "my-new-flag",
     "label": "My New Flag",
     "description": "What this flag controls",
     "defaultEnabled": false
   }
   ```

2. Run the sync script to copy the registry into bundled locations:

   ```bash
   bun run meta/feature-flags/sync-bundled-copies.ts
   ```

3. **Create the flag via Terraform in `vellum-assistant-platform`**. The CI feature-flag sync check will fail if a flag exists in the registry but not on the platform.

## Creating a Feature Gate

Define a constant using the flag's `id` directly and a predicate function that delegates to the resolver:

```typescript
import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import type { AssistantConfig } from "../config/schema.js";

const MY_FLAG = "my-flag" as const;

export function isMyFlagEnabled(config: AssistantConfig): boolean {
  return isAssistantFeatureFlagEnabled(MY_FLAG, config);
}
```

## Skill Feature-Flag Gating

A skill's SKILL.md frontmatter `featureFlag` field should reference the flag `id` directly:

```yaml
featureFlag: my-new-flag
```

Skills without a `featureFlag` field are always available. Skills that declare one are gated at six independent enforcement points — when the flag is OFF the skill is unavailable everywhere.

## Auth Scopes Are Unrelated

The OAuth/API scopes `feature_flags.read` and `feature_flags.write` control access to the feature-flag management API. They are **not** flag keys and should not be modified when adding or renaming flags.
