/**
 * Tests for the MemoryTab's v3 candidate-pool card: the pool renders collapsed
 * behind its size / pages-selected summary and expands to the candidate rows
 * with chosen rows marked, and a turn logged before pools were persisted
 * renders the empty state instead.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { LlmContextResponse, MemoryV3Pool } from "@vellumai/assistant-api";

import { MemoryTab } from "./memory-tab";

function contextWithPool(pool: MemoryV3Pool | null): LlmContextResponse {
  return {
    messageId: "msg-1",
    conversationKind: "user",
    conversationTotalEstimatedCostUsd: null,
    logs: [],
    memoryRecall: null,
    memoryV2Activation: null,
    memoryV3Selection: {
      turn: 3,
      live: true,
      selections: [
        {
          slug: "domain-a/page-1",
          source: "core",
          sectionOrdinal: null,
          sectionHeading: null,
        },
        {
          slug: "domain-b/page-2",
          source: "needle",
          sectionOrdinal: 2,
          sectionHeading: "Heading B",
        },
      ],
      injectedText: "",
      pool,
    },
  };
}

/** The pool the selector saw: two chosen cards and one unchosen hot card. */
const POOL: MemoryV3Pool = {
  poolSize: 3,
  selectedCount: 2,
  candidates: [
    {
      slug: "domain-a/page-1",
      lane: "core",
      sectionHeading: null,
      chosen: true,
    },
    {
      slug: "domain-c/page-9",
      lane: "hot",
      sectionHeading: null,
      chosen: false,
    },
    {
      slug: "domain-b/page-2",
      lane: "needle",
      sectionHeading: "Heading B",
      chosen: true,
    },
  ],
};

afterEach(cleanup);

describe("MemoryTab v3 candidate pool", () => {
  test("renders the pool collapsed behind its summary and expands to the candidate rows", () => {
    render(
      <MemoryTab context={contextWithPool(POOL)} assistantId="assistant-1" />,
    );

    const toggle = screen.getByRole("button", { name: /Candidate pool/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("3 candidates shown to the selector");
    expect(toggle.textContent).toContain("2 pages selected");
    // The unchosen hot card exists only in the pool, so it stays hidden while
    // collapsed; the needle selection's heading shows once, in the selection list.
    expect(screen.queryByText("domain-c/page-9")).toBeNull();
    expect(screen.getAllByText(/§ Heading B/)).toHaveLength(1);

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("domain-c/page-9")).toBeTruthy();
    expect(screen.getByText("hot")).toBeTruthy();
    expect(screen.getAllByText(/§ Heading B/)).toHaveLength(2);
    // Both chosen rows carry the marker chip; the unchosen hot card does not.
    expect(screen.getAllByText("selected")).toHaveLength(2);
  });

  test("renders the empty state for a turn logged before pools were persisted", () => {
    render(
      <MemoryTab context={contextWithPool(null)} assistantId="assistant-1" />,
    );

    expect(screen.getByText("Candidate pool")).toBeTruthy();
    expect(
      screen.getByText("No candidate pool was recorded for this turn."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Candidate pool/ })).toBeNull();
  });
});
