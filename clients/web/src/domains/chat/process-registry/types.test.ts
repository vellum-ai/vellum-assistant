import { describe, expect, it } from "bun:test";

import type {
  BackgroundProcessDescriptor,
  CardSummary,
} from "@/domains/chat/process-registry/types";

/**
 * These are type-level smoke checks: the real gate is `tsc --noEmit`. Each
 * `const` only has to *compile* against the descriptor contract. The runtime
 * assertions exist so the file is a valid test and so both `pill` variants are
 * referenced (and therefore type-checked).
 */
describe("BackgroundProcessDescriptor contract", () => {
  it("accepts the stacked pill variant", () => {
    const summary: CardSummary = {
      state: "loading",
      title: "Researcher",
      info: "Running",
      count: "3 agents",
    };

    const descriptor: BackgroundProcessDescriptor = {
      kind: "subagent",
      useActiveIds: () => ["a", "b"],
      useCardSummary: () => summary,
      renderCardLeading: () => null,
      pill: { variant: "stacked", renderChip: () => null, max: 3 },
      overlayTitle: (count) => `${count} agents`,
      pillAriaLabel: (count) => `${count} agents running`,
      openCardAriaLabel: "Open agents",
      onOpenDetail: () => {},
      onStop: () => {},
      DetailPanel: () => null,
    };

    expect(descriptor.pill.variant).toBe("stacked");
  });

  it("accepts the count pill variant and omitted optional fields", () => {
    const descriptor: BackgroundProcessDescriptor = {
      kind: "background-task",
      useActiveIds: () => [],
      // No `count` on the summary — valid for count-less kinds.
      useCardSummary: () => ({ state: "complete", title: "Task", info: "Done" }),
      renderCardLeading: () => null,
      pill: { variant: "count", glyph: null },
      overlayTitle: (count) => `${count} tasks`,
      pillAriaLabel: (count) => `${count} tasks running`,
      openCardAriaLabel: "Open tasks",
      onOpenDetail: () => {},
      // No `onStop` — valid for kinds without a stop action.
      DetailPanel: () => null,
    };

    expect(descriptor.pill.variant).toBe("count");
    expect(descriptor.onStop).toBeUndefined();
  });
});
