import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

// Snapshot of the greetings-only `users/default.md` seed this migration matches
// and rewrites. Its comment header and its two greeting lines describe the
// non-guardian privacy boundary as a "privacy boundary below", as if the
// boundary were part of this file. That boundary renders from the always-on
// bundled section `10a-non-guardian-boundary` and is absent from this file, so
// the wording is inaccurate. Matched byte-for-byte, so it is kept verbatim.
const GREETINGS_SEED_STALE_COMMENTS = `_ Lines starting with _ are comments — they won't appear in the system prompt.
_ This file shapes how you greet and frame conversations with people who are NOT your
_ guardian: a trusted contact your guardian has added, or someone you don't recognize.
_ Your guardian has their own users/<name>.md profile, so editing this file never changes
_ how you treat your guardian. The privacy boundary itself is built in and always renders
_ for non-guardian conversations, right after this persona — editing this file cannot
_ remove it.

{{#isTrustedContact}}
# You're talking with a trusted contact

The person you're talking to is a contact your guardian has added — not your guardian. Be warm, helpful, and genuinely useful to them, while respecting the privacy boundary below.

{{/isTrustedContact}}
{{#isStranger}}
# You're talking with someone you don't recognize

The person you're talking to is not your guardian, and you don't recognize them. Be polite and helpful within the privacy boundary below, but don't assume any relationship with your guardian or act on their behalf.

{{/isStranger}}
`;

// The corrected greetings-only template this migration writes. Its comment
// header states the privacy boundary is built in and not part of this file, and
// its two greeting lines reference the built-in privacy boundary. Byte-for-byte
// identical to the bundled `users/default.md` template.
const GREETINGS_SEED_CORRECTED = `_ Lines starting with _ are comments — they won't appear in the system prompt.
_ This file shapes how you greet and frame conversations with people who are NOT your
_ guardian: a trusted contact your guardian has added, or someone you don't recognize.
_ Your guardian has their own users/<name>.md profile, so editing this file never changes
_ how you treat your guardian. Edit the greetings and tone freely — the privacy boundary
_ that protects your guardian's personal information is built in and renders automatically
_ for every non-guardian conversation, so it isn't part of this file.

{{#isTrustedContact}}
# You're talking with a trusted contact

The person you're talking to is a contact your guardian has added — not your guardian. Be warm, helpful, and genuinely useful to them, while respecting the built-in privacy boundary.

{{/isTrustedContact}}
{{#isStranger}}
# You're talking with someone you don't recognize

The person you're talking to is not your guardian, and you don't recognize them. Be polite and helpful within the built-in privacy boundary, but don't assume any relationship with your guardian or act on their behalf.

{{/isStranger}}
`;

export const correctDefaultUserBoundaryCommentsMigration: WorkspaceMigration = {
  id: "124-correct-default-user-boundary-comments",
  description:
    "Rewrite the greetings-only users/default.md seed so its comments describe the non-guardian privacy boundary as the always-on bundled section it is, rather than a boundary living in this file",

  down(_workspaceDir: string): void {
    // No-op: we don't delete or revert user-editable persona files on rollback.
  },

  run(workspaceDir: string): void {
    const usersDir = join(workspaceDir, "users");
    const defaultPath = join(usersDir, "default.md");

    // Three cases:
    //   - absent/blank file → seed the corrected greetings template.
    //   - exact `GREETINGS_SEED_STALE_COMMENTS` match → rewrite it to the
    //     corrected template so the comments describe the privacy boundary as
    //     the built-in section it is, not a boundary "below" in this file.
    //   - anything else → the guardian customized the file; leave it untouched.
    if (existsSync(defaultPath)) {
      let content: string;
      try {
        content = readFileSync(defaultPath, "utf-8");
      } catch {
        // Unreadable file: leave it untouched rather than risk overwriting.
        return;
      }
      if (
        content.trim().length > 0 &&
        content !== GREETINGS_SEED_STALE_COMMENTS
      ) {
        return;
      }
    }

    mkdirSync(usersDir, { recursive: true });
    writeFileSync(defaultPath, GREETINGS_SEED_CORRECTED, "utf-8");
  },
};
