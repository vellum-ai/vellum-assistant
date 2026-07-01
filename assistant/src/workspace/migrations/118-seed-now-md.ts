import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migration-118");

/**
 * Stub contents for a freshly-seeded NOW.md. Every line is a `_`-prefixed
 * comment, so `stripCommentLines` reduces it to empty — the scratchpad injector
 * sees no content and injects nothing (zero token cost) until the assistant
 * writes real state. The file existing on disk is the point: the system prompt
 * tells the assistant it "has a scratchpad file (NOW.md) ... a single file you
 * overwrite", and `file_edit` requires the target to already exist, so an absent
 * NOW.md surfaces as "file not found" the first time the assistant follows that
 * instruction. The comment body mirrors the SOUL.md scratchpad framing so the
 * assistant has guidance in front of it when it overwrites the file.
 *
 * Inlined per the migrations self-containment rule.
 */
const NOW_MD_STUB = `_ NOW.md — your scratchpad. Overwrite this whole file with whatever is most
_ relevant right now. Unlike your journal (retrospective, append-only), this is
_ a single snapshot you keep current. It's loaded into your context
_ automatically, so next-you always sees the latest.
_
_ What goes here: your current focus and what you're actively working on; threads
_ you're tracking (waiting on a reply, monitoring something, pending follow-ups);
_ near-term priorities; temporary context that matters now but won't in a week.
_
_ What stays out: permanent facts (those live in memory/); personality and
_ principles (those live in SOUL.md).
_
_ Lines starting with _ are comments — they aren't loaded into your context.
_ Replace them freely.
`;

export const seedNowMdMigration: WorkspaceMigration = {
  id: "118-seed-now-md",
  description:
    "Seed a stub NOW.md scratchpad file so the prompt-referenced scratchpad exists on disk for read/edit",

  run(workspaceDir: string): void {
    // Create-only: write the stub solely when NOW.md is absent. The assistant
    // owns the file once it exists, so an existing NOW.md — seeded stub or real
    // content — is never clobbered. Unlike the onboarding-threads seed (069),
    // this is not gated on `isNewWorkspace`: the assistants hitting the missing
    // file are existing workspaces, and the comment-only stub injects nothing,
    // so re-creating it on upgrade is harmless and exactly the intended fix.
    const filePath = join(workspaceDir, "NOW.md");
    if (existsSync(filePath)) return;
    try {
      writeFileSync(filePath, NOW_MD_STUB, "utf-8");
    } catch (err) {
      log.warn({ err }, "Failed to seed NOW.md scratchpad stub");
    }
  },

  down(_workspaceDir: string): void {
    // Forward-only: never delete NOW.md on rollback. By the time a rollback
    // runs the assistant may have overwritten the stub with real scratchpad
    // state, and the file's existence is what keeps file_edit/read working.
  },
};
