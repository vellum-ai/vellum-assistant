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

2. Run the sync script so the bundled copies match the canonical registry:

   ```bash
   bun run meta/sync-bundled-copies.ts
   ```

   Commit the regenerated `clients/web/src/lib/feature-flags/feature-flag-registry.json` alongside `meta/feature-flags/feature-flag-registry.json`. CI byte-compares them (`bun run meta/sync-bundled-copies.ts --check`), so a stale copy fails the build.

3. Add a negative assertion to `clients/web/src/lib/feature-flags/feature-flag-catalog.test.ts`, following the existing block of such tests:

   ```typescript
   test("does not expose the retired my-flag as a feature flag", () => {
     expect("myFlag" in CLIENT_FLAG_DEFAULTS).toBe(false);
     expect("myFlag" in ASSISTANT_FLAG_DEFAULTS).toBe(false);
     expect("myFlag" in CLIENT_STRING_FLAG_DEFAULTS).toBe(false);
     expect("myFlag" in ASSISTANT_STRING_FLAG_DEFAULTS).toBe(false);
   });
   ```

   Assert against every catalog the flag's scope and type map to. `clients/web/src/lib/feature-flags/feature-flag-catalog.ts` exports four: `CLIENT_FLAG_DEFAULTS` and `ASSISTANT_FLAG_DEFAULTS` hold only boolean-valued flags, `CLIENT_STRING_FLAG_DEFAULTS` and `ASSISTANT_STRING_FLAG_DEFAULTS` only string-valued ones, and each is filtered to its own scope. Covering all four is the reliable choice: a subset that misses the retired flag's scope-and-type pair still passes after the key comes back, so an assistant-scoped string flag checked against the boolean pair plus the client string catalog is reintroduced silently. The assertion pins the removal so a later registry edit cannot quietly reintroduce the key.

4. Delete the flag's row from `meta/feature-flags/PENDING_PLATFORM_PRS.md` if one remains, and sweep the other rows for cross-references naming the retired key. A replacement flag's row often cites the key it supersedes.

5. **Archive the LaunchDarkly flag in a separate follow-up PR** in `vellum-assistant-platform` that sets `archived = true` on the flag's Terraform entry, unless the flag was never provisioned. A dark-shipped flag whose only platform record is the `PENDING_PLATFORM_PRS.md` row deleted in step 4 has no Terraform entry to archive, and retirement ends at step 4: do not create the flag on the platform just to archive it. Otherwise archive it, and **never remove the entry**: deleting the key destroys the LaunchDarkly flag and its history. See the "Feature Flags (LaunchDarkly)" section of `../vellum-assistant-platform/AGENTS.md` for the Terraform side. Open the archival PR for a provisioned flag as part of retiring it: app-side removals whose archival PR never follows leave orphaned live flags in LaunchDarkly with nothing left reading them.

   **Merge the archival PR only once every shipped reader of the flag has stopped reading it.** Archiving stops LaunchDarkly serving the flag's targeted value, so any build still reading the key silently falls back to its bundled registry default. The simplest case is a flag whose only reader is the hosted web bundle: the gate is the app-side PR merging and its web deploy going live. Two kinds of reader extend the wait past that point:

   - **Packaged desktop builds.** The macOS, Windows, and Linux apps bundle `clients/web/dist` into their installers and serve it from disk, so installed versions keep reading the key regardless of what the live website serves. Wait for the release carrying the removal to reach those users.
   - **Assistant-scope flags.** Assistant code resolves remote flags itself rather than through the web bundle, so a released assistant keeps reading the key until it updates.

   When readers like these exist, gate the archival on their rollout, not on the web deploy.

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
