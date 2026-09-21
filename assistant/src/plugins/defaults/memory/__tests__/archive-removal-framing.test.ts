/**
 * The daily archive (`memory/archive/`) holds raw buffer entries only. Per-turn
 * injection reads concept pages and never the archive, and text a pass
 * composes or derives on a page is not in it. So nothing the consolidation
 * agent reads may present the archive as making removal safe: that framing
 * licenses deleting filed content that exists nowhere else.
 *
 * The check is sentence-level: no sentence may pair the archive with
 * reassurance that removing content loses nothing. A sentence warning that
 * removed text IS lost stays allowed.
 */
import { describe, expect, test } from "bun:test";

import { renderConsolidationPrompt } from "../substrate/prompts/consolidation.js";
import { deleteMemoryPageTool } from "../tools.js";

function archiveSafetyClaims(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter(
      (sentence) =>
        /archive/i.test(sentence) &&
        /don.t worry|no need to worry|never los|nothing is lost|won.t lose|safe to (?:delete|remove|cut|drop)/i.test(
          sentence,
        ),
    );
}

describe("the archive is never framed as making removal safe", () => {
  test("neither consolidation article shape makes the claim", () => {
    const v2 = renderConsolidationPrompt("May 1, 12:00 PM", {
      includeCorePagesSection: false,
      articleShape: "v2",
      bufferEntries: "",
    });
    // The over-long-sections step carries the one legitimate archive
    // sentence, so the v3 render includes it.
    const v3 = renderConsolidationPrompt("May 1, 12:00 PM", {
      includeCorePagesSection: true,
      articleShape: "v3",
      bufferEntries: "",
      overlongSections: {
        windowChars: 6000,
        sections: [{ slug: "journal", title: "", chars: 7200 }],
      },
    });

    expect(v3).toContain("the archive is a record");
    expect(archiveSafetyClaims(v2)).toEqual([]);
    expect(archiveSafetyClaims(v3)).toEqual([]);
  });

  test("a warning that removed text is lost is not the claim", () => {
    expect(
      archiveSafetyClaims(
        "Text you cut from a page is lost to retrieval: the archive does not bring it back.",
      ),
    ).toEqual([]);
  });

  test("the delete_memory_page description does not make the claim", () => {
    expect(archiveSafetyClaims(deleteMemoryPageTool.description)).toEqual([]);
  });
});
