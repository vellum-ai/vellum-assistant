import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migration-045-release-notes-meet-avatar");

const MIGRATION_ID = "045-release-notes-meet-avatar";
const MARKER = `<!-- release-note-id:${MIGRATION_ID} -->`;

const RELEASE_NOTE = `${MARKER}
## Meet video avatar with lip-sync (v1)

I can now appear as a video avatar during Google Meet calls, with lip-sync
driven by my TTS output. v1 uses the TalkingHead.js renderer running inside
the meet-bot container; hosted renderers (Simli, HeyGen) and GPU sidecars
(SadTalker, MuseTalk) are additive follow-ups and are not yet available.

### One-time setup (required before enabling)

The repo currently ships a placeholder \`default-avatar.glb\` at
\`skills/meet-join/meet-controller-ext/avatar/default-avatar.glb\` that is
**0 bytes** — the avatar will fail fast at enable time until you replace
it with a real Ready Player Me model. Export a \`.glb\` from Ready Player Me
and drop it at that path before turning the feature on.

### Host setup (Linux only)

The avatar publishes frames to a virtual camera via \`v4l2loopback\`. On
the Linux host that runs the assistant:

\`\`\`bash
sudo apt-get install v4l2loopback-dkms
sudo modprobe v4l2loopback video_nr=10 card_label="VellumAvatar" exclusive_caps=1
\`\`\`

macOS bare-metal is **not supported** for the avatar in v1 — the virtual
camera stack is Linux-specific.

### Enabling the avatar

In your Meet service config, set:

\`\`\`json
{
  "services": {
    "meet": {
      "avatar": { "enabled": true, "renderer": "talking-head" }
    }
  }
}
\`\`\`

**Docker mode:** additionally export \`VELLUM_MEET_AVATAR=1\` in the CLI
environment **before** spawning the instance, so the CLI bind-mounts
\`/dev/video10\` into the assistant container. Without this, the inner
\`dockerd\` has no device to pass through to the meet-bot.

### New tools

Two new assistant tools are available (feature-flag gated on \`meet\`):

- \`meet_enable_avatar\` — turn the avatar on for a meeting.
- \`meet_disable_avatar\` — turn the avatar off for a meeting.

Ask me to enable or disable my avatar in a Meet and I'll call these for you.
`;

/**
 * Release-notes migration for the Meet video avatar feature (Phase 4).
 *
 * Per AGENTS.md § Release Update Hygiene, user-facing changes ship notes via a
 * workspace migration that appends to `<workspace>/UPDATES.md`. The in-file
 * HTML marker guards against duplicate appends if the runner re-executes this
 * migration after a mid-run crash (between `appendFileSync` and the runner's
 * checkpoint promotion to `applied`), which the runner's own checkpoint state
 * does not cover on its own.
 */
export const releaseNotesMeetAvatarMigration: WorkspaceMigration = {
  id: MIGRATION_ID,
  description:
    "Append release notes for Meet video avatar with lip-sync to UPDATES.md",

  run(workspaceDir: string): void {
    const updatesPath = join(workspaceDir, "UPDATES.md");

    try {
      if (existsSync(updatesPath)) {
        const existing = readFileSync(updatesPath, "utf-8");
        if (existing.includes(MARKER)) {
          // Marker already present — a prior run of this migration appended
          // the note. Short-circuit to keep the migration idempotent across
          // the narrow crash window between append and runner checkpoint.
          return;
        }
        // Ensure separation from prior content.
        const needsLeadingNewline = !existing.endsWith("\n\n");
        const prefix = existing.endsWith("\n") ? "\n" : "\n\n";
        appendFileSync(
          updatesPath,
          needsLeadingNewline ? `${prefix}${RELEASE_NOTE}` : RELEASE_NOTE,
          "utf-8",
        );
      } else {
        writeFileSync(updatesPath, RELEASE_NOTE, "utf-8");
      }
      log.info(
        { path: updatesPath },
        "Appended Meet video avatar release note",
      );
    } catch (err) {
      log.warn(
        { err, path: updatesPath },
        "Failed to append Meet video avatar release note to UPDATES.md",
      );
    }
  },

  down(_workspaceDir: string): void {
    // Forward-only: UPDATES.md is a user-facing bulletin the assistant
    // processes and deletes on its own. Attempting to reverse a note that may
    // have already been read/deleted would risk surprising user-visible state.
  },
};
