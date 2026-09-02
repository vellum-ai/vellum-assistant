# Feature Flags — Agent Instructions

## Naming Convention

Feature flag keys are **simple kebab-case strings** with no prefix or suffix:

```
"browser"
"a2a-channel"
"conversation-starters"
"conversation-starters"
```

The `id` and `key` fields in `feature-flag-registry.json` **must match** and both use kebab-case. client-scope flags follow the same convention:

```
"user-hosted-enabled"
"quick-input"
"expand-completed-steps"
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

   Use `"defaultEnabled": false` for new gated features unless the feature is intentionally GA. Locally declared flags that are missing from a remote platform snapshot fall back to this registry default; undeclared flags fail closed.

2. Run the sync script to copy the registry into bundled locations:

   ```bash
   bun run meta/sync-bundled-copies.ts
   ```

3. **Create the flag via Terraform in `vellum-assistant-platform`** so it exists on the platform for remote sync.

## Retiring a Flag

1. **Remove the code reads and the registry entry in the same PR.** A registry-only removal breaks the gated surface silently: the web flag stores hold `Record<string, boolean>` state behind the `createSelectors` Proxy (`clients/web/src/utils/create-selectors.ts`), so `store.use.<removedKey>()` still type-checks and just returns `undefined`. The gate reads falsy, the surface vanishes, and no type check or test fails.

2. Run `bun run meta/sync-bundled-copies.ts`. Commit the regenerated `clients/web/src/lib/feature-flags/feature-flag-registry.json` alongside `meta/feature-flags/feature-flag-registry.json`. CI byte-compares them (`bun run meta/sync-bundled-copies.ts --check`), so a stale copy fails the build.

3. Add a negative assertion to `clients/web/src/lib/feature-flags/feature-flag-catalog.test.ts`, following the existing block of such tests:

   ```typescript
   test("does not expose the retired my-flag as a feature flag", () => {
     expect("myFlag" in CLIENT_FLAG_DEFAULTS).toBe(false);
     expect("myFlag" in ASSISTANT_FLAG_DEFAULTS).toBe(false);
     expect("myFlag" in CLIENT_STRING_FLAG_DEFAULTS).toBe(false);
     expect("myFlag" in ASSISTANT_STRING_FLAG_DEFAULTS).toBe(false);
   });
   ```

   Assert the key is absent from all four catalogs `feature-flag-catalog.ts` exports, as the sample does. A subset can silently miss the flag's own scope-and-type pair, so an assistant-scoped string flag checked against only the two boolean catalogs and the client string one still passes once the key comes back.

4. Delete the flag's row from `meta/feature-flags/PENDING_PLATFORM_PRS.md` if one remains, and sweep the other rows for cross-references naming the retired key. A replacement flag's row often cites the key it supersedes. Read the row's Status column before deleting it: a pending row can track an already-open provisioning PR in `vellum-assistant-platform` rather than unstarted work. Close that PR, or update it to drop the retired key, as part of the retirement. Deleting the row alone leaves the PR free to merge later and create a live LaunchDarkly flag with no reader and nothing left tracking its cleanup.

5. **Archive the LaunchDarkly flag in a separate follow-up PR** in `vellum-assistant-platform`. The app-code PR of steps 1 through 4 goes first, and the archival PR is opened as part of the same retirement: an app-side removal whose archival never follows leaves an orphaned live flag with nothing reading it.

   **Merge the archival PR only once every shipped reader has stopped reading the flag.** Archiving stops LaunchDarkly serving the targeted value, so any build still reading the key silently falls back to its bundled registry default. A flag whose only reader is the hosted web bundle is the simplest case: the app-code PR merging and its web deploy going live is the whole gate. Packaged desktop builds serve `clients/web/dist` from disk, and assistant code resolves remote flags itself rather than through the web bundle, so either one keeps reading the key until the release carrying the removal reaches users. Gate the archival on that rollout instead of on the web deploy.

   **A flag that was never provisioned is the exception.** A dark-shipped flag whose only platform record is the `PENDING_PLATFORM_PRS.md` row deleted in step 4 has no Terraform entry to archive. Retirement ends at step 4 once that row is gone and any provisioning PR it links is closed. Do not create the flag on the platform just to archive it.

   Archive, never delete: removing the entry destroys the LaunchDarkly flag and its history. See the "Feature Flags (LaunchDarkly)" section of `../vellum-assistant-platform/AGENTS.md` for the Terraform mechanics.

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
