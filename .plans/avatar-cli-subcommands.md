# Avatar CLI Subcommands

## Overview
Add `set`, `remove`, and `get` subcommands to the `assistant avatar` CLI, and retrofit event publishing + IDENTITY.md management into the existing `generate` and `character update` commands. This closes the capability gap between the CLI and the bundled settings tools (`avatar-update`, `avatar-remove`, `avatar-get`), enabling the `vellum-avatar` skill to use CLI commands exclusively for all avatar operations.

## PR 1: Shared avatar infrastructure for CLI use
### Depends on
None

### Branch
avatar-cli-cmds/pr-1-infra

### Title
refactor(avatar): extract identity helper and add daemon notification for CLI

### Files
- `assistant/src/avatar/identity-avatar.ts`
- `assistant/src/config/bundled-skills/settings/tools/identity-avatar.ts`
- `assistant/src/config/bundled-skills/settings/tools/avatar-update.ts`
- `assistant/src/config/bundled-skills/settings/tools/avatar-remove.ts`
- `assistant/src/runtime/routes/avatar-routes.ts`
- `assistant/src/cli/lib/daemon-avatar-client.ts`

### Implementation steps
1. Create `assistant/src/avatar/identity-avatar.ts` by moving the `updateIdentityAvatarSection` function from `assistant/src/config/bundled-skills/settings/tools/identity-avatar.ts`. Keep the same function signature and implementation. The function reads `IDENTITY.md` from `getWorkspaceDir()`, matches the `## Avatar` section via regex, and replaces or appends it.

2. Update `assistant/src/config/bundled-skills/settings/tools/identity-avatar.ts` to re-export from the new shared location:
   ```ts
   export { updateIdentityAvatarSection } from "../../../../avatar/identity-avatar.js";
   ```
   This preserves the existing import paths in `avatar-update.ts` and `avatar-remove.ts` without any changes to those files.

3. Add a `POST /v1/avatar/notify-updated` endpoint to `assistant/src/runtime/routes/avatar-routes.ts`. The handler calls the existing `publishAvatarUpdated()` private function (already defined in that file at line 18) and returns `{ ok: true }`. Use the existing `RouteDefinition` pattern with a `z.object({ ok: z.boolean() })` response body schema. No request body needed.

4. Create `assistant/src/cli/lib/daemon-avatar-client.ts` with a single exported function:
   ```ts
   export async function notifyAvatarUpdated(): Promise<void>
   ```
   This follows the same daemon HTTP pattern as `daemon-credential-client.ts`: check daemon health via `isHttpHealthy()`, mint a JWT via `mintDaemonDeliveryToken()`, and POST to `/v1/avatar/notify-updated`. Fire-and-forget — catch all errors and log a warning. If the daemon is unreachable, silently return (the avatar files are already written; the client just won't refresh until next poll). Use the same `DAEMON_FETCH_TIMEOUT_MS` (60s) constant pattern. Import `getRuntimeHttpHost`, `getRuntimeHttpPort` from `../../config/env.js`, `healthCheckHost`, `isHttpHealthy` from `../../daemon/daemon-control.js`, and `initAuthSigningKey`, `loadOrCreateSigningKey`, `mintDaemonDeliveryToken` from `../../runtime/auth/token-service.js`.

### Acceptance criteria
- `updateIdentityAvatarSection` is importable from `assistant/src/avatar/identity-avatar.ts`
- The existing settings tools (`avatar-update.ts`, `avatar-remove.ts`) continue to work unchanged via the re-export
- `POST /v1/avatar/notify-updated` returns `{ ok: true }` and triggers SSE `avatar_updated` events to connected clients
- `notifyAvatarUpdated()` succeeds silently when the daemon is not running
- TypeScript compiles without errors

## PR 2: Add set, remove, get subcommands and retrofit event hooks
### Depends on
PR 1

### Branch
avatar-cli-cmds/pr-2-subcommands

### Title
feat(avatar-cli): add set, remove, get subcommands and event publishing

### Files
- `assistant/src/cli/commands/avatar.ts`

### Implementation steps
1. Add the following imports to `avatar.ts`:
   - `copyFileSync`, `mkdirSync` from `node:fs` (add to existing `existsSync, readFileSync, unlinkSync` import)
   - `dirname` from `node:path` (add to existing `join` import)
   - `getAvatarDir`, `getAvatarImagePath` from `../../util/platform.js` (add to existing `getWorkspaceDir` import)
   - `updateIdentityAvatarSection` from `../../avatar/identity-avatar.js`
   - `notifyAvatarUpdated` from `../lib/daemon-avatar-client.js`

2. Add `assistant avatar set` subcommand after the existing `generate` subcommand (after line 105). Implementation:
   ```
   avatar.command("set")
     .description("Set the assistant's avatar from an image file")
     .requiredOption("--image <path>", "Path to image file (absolute or relative to workspace)")
     .addHelpText("after", ...)
     .action(async (opts) => { ... })
   ```
   The action handler should:
   - Resolve the image path: if it starts with `/`, use as-is; otherwise `join(getWorkspaceDir(), opts.image)`
   - Validate the resolved path exists via `existsSync`
   - Get the canonical avatar path via `getAvatarImagePath()`
   - Create the avatar directory via `mkdirSync(dirname(avatarPath), { recursive: true })`
   - Copy the image via `copyFileSync(resolvedSource, avatarPath)`
   - Preserve `character-traits.json` (do NOT delete it — this matches the settings tool behavior, allowing character restoration)
   - Call `updateIdentityAvatarSection(null, ...)` to clear the avatar description (pass a minimal logger object wrapping `log.warn`)
   - Call `await notifyAvatarUpdated()` to refresh connected clients
   - Log success with `log.info`
   - On any error, log with `log.error` and set `process.exitCode = 1`

   Help text should include 2-3 examples:
   ```
   $ assistant avatar set --image /path/to/photo.png
   $ assistant avatar set --image conversations/abc123/attachments/Dropped\ Image.png
   ```

3. Add `assistant avatar remove` subcommand after the new `set` subcommand. Implementation:
   ```
   avatar.command("remove")
     .description("Remove custom avatar and restore character default")
     .addHelpText("after", ...)
     .action(async () => { ... })
   ```
   The action handler should:
   - Get the avatar path via `getAvatarImagePath()`
   - If the file doesn't exist, log "No custom avatar to remove — already using the default." and return (not an error)
   - Delete the file via `unlinkSync(avatarPath)`
   - Preserve `character-traits.json` (do NOT delete it — character avatar auto-restores)
   - Call `updateIdentityAvatarSection("Default character avatar (no custom image set)", ...)`
   - Call `await notifyAvatarUpdated()`
   - Log success with `log.info`

   Help text should explain that native character is restored automatically if one was previously configured.

4. Add `assistant avatar get` subcommand after `remove`. Implementation:
   ```
   avatar.command("get")
     .description("Retrieve the current avatar")
     .option("--format <format>", "Output format: path or base64", "path")
     .addHelpText("after", ...)
     .action(async (opts) => { ... })
   ```
   The action handler should:
   - Validate `opts.format` is either `"path"` or `"base64"`; error if not
   - Check if custom avatar image exists at `getAvatarImagePath()`
   - If not, check for `character-traits.json` in `getAvatarDir()`
   - If traits exist, regenerate the PNG via `writeTraitsAndRenderAvatar(JSON.parse(readFileSync(traitsPath, "utf-8")))` and check if avatar image now exists
   - If still no image, log "No avatar is currently set — no custom image and no character traits found." and return
   - For `--format path`: write the absolute path to stdout via `process.stdout.write(avatarPath + "\n")`
   - For `--format base64`: read the file with `readFileSync(avatarPath)`, convert to base64 via `.toString("base64")`, and write to stdout via `process.stdout.write(base64 + "\n")`

   Help text should explain both output formats and include examples:
   ```
   $ assistant avatar get
   $ assistant avatar get --format base64
   $ assistant avatar get --format path
   ```

5. Retrofit the existing `generate` subcommand (lines 71-105) to add event publishing and IDENTITY.md management after the success path (after the trait file cleanup on lines 97-101):
   - Call `updateIdentityAvatarSection(null, ...)` to clear the avatar description so the assistant re-describes the new AI-generated image
   - Call `await notifyAvatarUpdated()` to refresh connected clients

6. Retrofit the existing `character update` subcommand (lines 166-222) to add event publishing and IDENTITY.md management after the success path (after `result.ok` check, before logging):
   - Call `updateIdentityAvatarSection(null, ...)` to clear the avatar description so the assistant re-describes the new character
   - Call `await notifyAvatarUpdated()` to refresh connected clients

### Acceptance criteria
- `assistant avatar set --image <path>` copies the image to the canonical avatar location, clears the IDENTITY.md avatar description, and notifies the daemon
- `assistant avatar set` preserves `character-traits.json` so removing the custom image later restores the character
- `assistant avatar set` with a non-existent path prints an error and exits with code 1
- `assistant avatar remove` deletes the custom avatar image but preserves `character-traits.json`
- `assistant avatar remove` when no custom avatar exists prints a friendly message and exits cleanly (code 0)
- `assistant avatar get` prints the absolute path to the avatar image by default
- `assistant avatar get --format base64` prints the base64-encoded PNG content
- `assistant avatar get` regenerates the PNG from character traits if only traits exist (no image file)
- `assistant avatar get` when no avatar or traits exist prints a message and exits cleanly
- `assistant avatar generate` now publishes `avatar_updated` events and clears IDENTITY.md
- `assistant avatar character update` now publishes `avatar_updated` events and clears IDENTITY.md
- All subcommands have `--help` text with examples following CLI AGENTS.md conventions
- TypeScript compiles without errors
