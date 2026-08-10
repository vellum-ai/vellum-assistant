/**
 * Tests for the pure placement helpers.
 *
 * {@link resolvePlacementSurfacedAt} is a twin of the daemon's
 * `batchSetConversationPlacement`, so the cases below are the branches that
 * write actually takes: the promotion, the demotion, and the rows it leaves
 * alone. A rule that drifts from the SQL shows up as a row that moves into a
 * section optimistically and moves back out when the refetch lands.
 */

import { describe, expect, test } from "bun:test";

import type { Conversation } from "@/types/conversation-types";
import { resolvePlacementSurfacedAt } from "@/domains/chat/hooks/conversation-action-utils";

const NOW = 1_700_000_000_000;

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return { conversationId: "c1", ...overrides };
}

describe("resolvePlacementSurfacedAt", () => {
  test("pinning a background run stamps the promotion", () => {
    // `system:pinned` fails the custom-group arm of the daemon's
    // standard-listing visibility on its `system:` prefix, so the stamp is
    // the only thing that puts a pinned background row in the sidebar.
    expect(
      resolvePlacementSurfacedAt(
        conversation({ conversationType: "background" }),
        "system:pinned",
        NOW,
      ),
    ).toBe(NOW);
  });

  test("filing a scheduled run into a custom group stamps it too", () => {
    expect(
      resolvePlacementSurfacedAt(
        conversation({ conversationType: "scheduled" }),
        "group-uuid",
        NOW,
      ),
    ).toBe(NOW);
  });

  test("an existing promotion time survives a re-file", () => {
    // The daemon's COALESCE: re-filing keeps the original promotion time.
    expect(
      resolvePlacementSurfacedAt(
        conversation({ conversationType: "background", surfacedAt: 5 }),
        "group-uuid",
        NOW,
      ),
    ).toBe(5);
  });

  test("moving into the background or scheduled bucket clears it", () => {
    for (const groupId of ["system:background", "system:scheduled"]) {
      expect(
        resolvePlacementSurfacedAt(
          conversation({ conversationType: "background", surfacedAt: 5 }),
          groupId,
          NOW,
        ),
      ).toBeUndefined();
    }
  });

  test("a standard conversation is never stamped", () => {
    // Everything outside the two automated types is already visible, so a
    // stamp would leave `surfacedAt` meaning nothing.
    expect(
      resolvePlacementSurfacedAt(conversation(), "system:pinned", NOW),
    ).toBeUndefined();
    expect(
      resolvePlacementSurfacedAt(conversation(), "group-uuid", NOW),
    ).toBeUndefined();
  });

  test("returning to system:all neither stamps nor clears", () => {
    expect(
      resolvePlacementSurfacedAt(
        conversation({ conversationType: "background", surfacedAt: 5 }),
        "system:all",
        NOW,
      ),
    ).toBe(5);
    expect(
      resolvePlacementSurfacedAt(
        conversation({ conversationType: "background" }),
        "system:all",
        NOW,
      ),
    ).toBeUndefined();
  });
});
