/**
 * Workspace migration 088: Deprecate stale
 * `prompts/system/08-background-conversation.md` overrides.
 *
 * PR #31210 moved the background-conversation guidance out of the bundled
 * system prompt and into a per-turn user-message injector. As a side effect:
 *
 *   - Workspace overrides that gated on `{{#isBackgroundConversation}}` now
 *     evaluate the gate as false (the key is no longer passed to the system
 *     prompt context) and silently stop rendering in background turns.
 *   - Plain-text overrides without a gate would now render unconditionally
 *     in ALL conversations — the opposite of intended behavior.
 *
 * Either failure mode is silent. To prevent it, this migration renames any
 * existing `prompts/system/08-background-conversation.md` to
 * `08-background-conversation.md.deprecated` so the section-discovery walker
 * (which only picks up `.md` files) stops loading it, while preserving the
 * user's customized text on disk for manual review.
 *
 * Idempotent: re-runs after `08-background-conversation.md` has already been
 * renamed are no-ops. If both files exist (a user re-created the override
 * after a prior partial run), the bundled section is gone — drop the `.md`
 * and keep the previously-preserved `.deprecated` copy.
 */

import { existsSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger(
  "workspace-migration-088-deprecate-background-conversation-override",
);

const OVERRIDE_FILENAME = "08-background-conversation.md";
const DEPRECATED_FILENAME = "08-background-conversation.md.deprecated";

export const deprecateBackgroundConversationOverrideMigration: WorkspaceMigration =
  {
    id: "088-deprecate-background-conversation-override",
    description:
      "Rename stale prompts/system/08-background-conversation.md overrides to .deprecated so they stop rendering after the section moved to a per-turn injector",
    retryFailedCheckpoint: true,

    run(workspaceDir: string): void {
      const promptDir = join(workspaceDir, "prompts", "system");
      const overridePath = join(promptDir, OVERRIDE_FILENAME);
      const deprecatedPath = join(promptDir, DEPRECATED_FILENAME);

      if (!existsSync(overridePath)) return;

      if (existsSync(deprecatedPath)) {
        try {
          unlinkSync(overridePath);
          log.info(
            { path: overridePath, preserved: deprecatedPath },
            "Removed re-created background-conversation override; preserved copy already exists",
          );
        } catch (err) {
          log.warn(
            { err, path: overridePath },
            "Failed to remove background-conversation override",
          );
          throw err;
        }
        return;
      }

      try {
        renameSync(overridePath, deprecatedPath);
        log.info(
          { from: overridePath, to: deprecatedPath },
          "Renamed stale background-conversation override to .deprecated",
        );
      } catch (err) {
        log.warn(
          { err, from: overridePath, to: deprecatedPath },
          "Failed to rename background-conversation override",
        );
        throw err;
      }
    },

    down(workspaceDir: string): void {
      const promptDir = join(workspaceDir, "prompts", "system");
      const overridePath = join(promptDir, OVERRIDE_FILENAME);
      const deprecatedPath = join(promptDir, DEPRECATED_FILENAME);

      if (!existsSync(deprecatedPath)) return;
      if (existsSync(overridePath)) return;

      try {
        renameSync(deprecatedPath, overridePath);
      } catch (err) {
        log.warn(
          { err, from: deprecatedPath, to: overridePath },
          "Failed to restore background-conversation override",
        );
        throw err;
      }
    },
  };
