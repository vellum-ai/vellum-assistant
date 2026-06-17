import { describe, expect, test } from "bun:test";

import type { DisplayMessage, Surface } from "@/domains/chat/types/types";
import {
  filterMessageSurfaces,
  mapMessageSurfaces,
} from "@/domains/chat/utils/map-message-surfaces";

function surface(
  overrides: Partial<Surface> & Pick<Surface, "surfaceId">,
): Surface {
  return {
    surfaceType: "form",
    data: {},
    ...overrides,
  };
}

function assistantMessage(surfaces: Surface[]): DisplayMessage {
  return {
    id: "msg-1",
    role: "assistant",
    surfaces,
    contentOrder: surfaces.map((s) => ({
      type: "surface" as const,
      id: s.surfaceId,
    })),
    contentBlocks: surfaces.map((s) => ({ type: "surface", surface: s })),
  };
}

describe("mapMessageSurfaces", () => {
  test("patches the matching surface block in lockstep with surfaces", () => {
    /**
     * A transform that mutates a surface must update both the positional
     * `surfaces` entry and the `surface` block carrying the same surfaceId,
     * since the transcript renders straight off the blocks.
     */

    // GIVEN an assistant message with two surfaces
    const message = assistantMessage([
      surface({ surfaceId: "s-a", title: "old" }),
      surface({ surfaceId: "s-b" }),
    ]);

    // WHEN s-a is marked completed
    const next = mapMessageSurfaces(message, (s) =>
      s.surfaceId === "s-a" ? { ...s, completed: true } : s,
    );

    // THEN both the positional surface and its block reflect the change
    expect(next.surfaces?.[0]?.completed).toBe(true);
    const blockA = next.contentBlocks?.find(
      (b) => b.type === "surface" && b.surface.surfaceId === "s-a",
    );
    expect(blockA?.type === "surface" ? blockA.surface.completed : false).toBe(
      true,
    );

    // AND the untouched surface keeps its block reference (stable identity)
    const blockB = next.contentBlocks?.find(
      (b) => b.type === "surface" && b.surface.surfaceId === "s-b",
    );
    expect(blockB).toBe(message.contentBlocks?.[1]);
  });

  test("returns the same message reference when no surface changes", () => {
    /**
     * Callers rely on identity-based change detection, so a no-op transform
     * must return the original message untouched.
     */

    // GIVEN an assistant message with a surface
    const message = assistantMessage([surface({ surfaceId: "s-a" })]);

    // WHEN a transform leaves every surface unchanged
    const next = mapMessageSurfaces(message, (s) => s);

    // THEN the same reference is returned
    expect(next).toBe(message);
  });

  test("is a no-op for messages without surfaces", () => {
    /**
     * Text-only rows carry no surfaces; the helper must pass them through
     * verbatim.
     */

    // GIVEN a user message with no surfaces
    const message: DisplayMessage = {
      id: "msg-1",
      role: "user",
      textSegments: ["hi"],
    };

    // WHEN the helper runs
    const next = mapMessageSurfaces(message, (s) => ({ ...s, completed: true }));

    // THEN the message is returned untouched
    expect(next).toBe(message);
  });
});

describe("filterMessageSurfaces", () => {
  test("drops surfaces from surfaces, contentOrder, and contentBlocks together", () => {
    /**
     * Removing a surface (dismissal) must strip it from all three projections
     * so the block-driven render stops showing it.
     */

    // GIVEN an assistant message with two surfaces
    const message = assistantMessage([
      surface({ surfaceId: "s-a" }),
      surface({ surfaceId: "s-b" }),
    ]);

    // WHEN s-a is filtered out
    const next = filterMessageSurfaces(message, (s) => s.surfaceId !== "s-a");

    // THEN s-a is gone from every projection
    expect(next.surfaces?.map((s) => s.surfaceId)).toEqual(["s-b"]);
    expect(next.contentOrder?.map((e) => e.id)).toEqual(["s-b"]);
    expect(
      next.contentBlocks?.map((b) =>
        b.type === "surface" ? b.surface.surfaceId : null,
      ),
    ).toEqual(["s-b"]);
  });

  test("returns the same message reference when nothing is dropped", () => {
    /**
     * A predicate that keeps every surface is a no-op and must preserve
     * identity for callers' change detection.
     */

    // GIVEN an assistant message with a surface
    const message = assistantMessage([surface({ surfaceId: "s-a" })]);

    // WHEN the predicate keeps everything
    const next = filterMessageSurfaces(message, () => true);

    // THEN the same reference is returned
    expect(next).toBe(message);
  });
});
