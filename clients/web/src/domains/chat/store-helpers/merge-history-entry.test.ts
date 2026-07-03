import { describe, expect, it } from "bun:test";
import {
  mergeTerminalStatus,
  seedEntriesFromHistory,
} from "@/domains/chat/store-helpers/merge-history-entry";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Status = "running" | "completed" | "failed" | "cancelled";

const isActive = (status: Status): boolean => status === "running";

interface Entry {
  id: string;
  status: Status;
  output?: string;
}

const merge = (existing: Entry, incoming: Entry): Entry => ({
  ...existing,
  status: mergeTerminalStatus(existing.status, incoming.status, isActive),
  output: incoming.output ?? existing.output,
});

// ---------------------------------------------------------------------------
// mergeTerminalStatus
// ---------------------------------------------------------------------------

describe("mergeTerminalStatus", () => {
  it("does not regress a live terminal status to stale active history", () => {
    // Live entry already settled; a stale snapshot still shows it running.
    expect(mergeTerminalStatus("completed", "running", isActive)).toBe(
      "completed",
    );
  });

  it("lets a terminal history status win over a live active one", () => {
    // History knows the process finished; the live entry is still "running".
    expect(mergeTerminalStatus("running", "completed", isActive)).toBe(
      "completed",
    );
  });

  it("takes the incoming status when both are active", () => {
    expect(mergeTerminalStatus("running", "running", isActive)).toBe("running");
  });

  it("takes the incoming status when both are terminal", () => {
    // A terminal history status replaces a different live terminal one.
    expect(mergeTerminalStatus("failed", "completed", isActive)).toBe(
      "completed",
    );
  });
});

// ---------------------------------------------------------------------------
// seedEntriesFromHistory
// ---------------------------------------------------------------------------

describe("seedEntriesFromHistory", () => {
  it("inserts unseen entries and appends their ids in order", () => {
    const result = seedEntriesFromHistory({
      entries: [
        { id: "a", status: "running" },
        { id: "b", status: "completed" },
      ],
      byId: {},
      orderedIds: [],
      idOf: (e: Entry) => e.id,
      merge,
    });

    expect(result.orderedIds).toEqual(["a", "b"]);
    expect(result.byId.a.status).toBe("running");
    expect(result.byId.b.status).toBe("completed");
  });

  it("merges known entries without duplicating ids or reordering", () => {
    const result = seedEntriesFromHistory({
      entries: [
        { id: "b", status: "completed", output: "done" },
        { id: "c", status: "running" },
      ],
      byId: {
        a: { id: "a", status: "completed" },
        b: { id: "b", status: "running" },
      },
      orderedIds: ["a", "b"],
      idOf: (e: Entry) => e.id,
      merge,
    });

    // Existing ids keep their order; new ids are appended.
    expect(result.orderedIds).toEqual(["a", "b", "c"]);
    // Terminal history wins over the live "running" entry, and metadata folds in.
    expect(result.byId.b.status).toBe("completed");
    expect(result.byId.b.output).toBe("done");
  });

  it("does not regress a live terminal entry from stale history", () => {
    const result = seedEntriesFromHistory({
      // Stale snapshot still reports the task as running.
      entries: [{ id: "a", status: "running" }],
      byId: { a: { id: "a", status: "completed" } },
      orderedIds: ["a"],
      idOf: (e: Entry) => e.id,
      merge,
    });

    expect(result.byId.a.status).toBe("completed");
    expect(result.orderedIds).toEqual(["a"]);
  });

  it("returns fresh byId/orderedIds containers (reference stability)", () => {
    const byId = { a: { id: "a", status: "running" as Status } };
    const orderedIds = ["a"];

    const result = seedEntriesFromHistory({
      entries: [{ id: "a", status: "completed" }],
      byId,
      orderedIds,
      idOf: (e: Entry) => e.id,
      merge,
    });

    expect(result.byId).not.toBe(byId);
    expect(result.orderedIds).not.toBe(orderedIds);
    // The input containers are not mutated.
    expect(byId.a.status).toBe("running");
    expect(orderedIds).toEqual(["a"]);
  });
});
