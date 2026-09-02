/**
 * Tests for `HomeGuardianRequestCard`.
 *
 * The decision mutation and the assistant store are stubbed the way
 * `notifications-bell.test.tsx` stubs its query layer, so the card renders
 * without a QueryClientProvider and the tests can assert exactly what a
 * click submits to the canonical decision route.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";

import { fireEvent, render, screen } from "@testing-library/react";

import {
  GUARDIAN_TERMINAL_REASON_SUPERSEDED,
  type FeedItem,
  type FeedItemGuardianRequest,
} from "@vellumai/assistant-api";

import { feedItem } from "../feed-test-fixtures";

interface RecordedMutateCall {
  path?: { assistant_id?: string };
  body?: { requestId?: string; action?: string };
}

const mutateCalls: RecordedMutateCall[] = [];

mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  useGuardianactionsDecisionPostMutation: () => ({
    mutate: (variables: RecordedMutateCall) => {
      mutateCalls.push(variables);
    },
    isPending: false,
    data: undefined,
    variables: undefined,
    reset: () => {},
  }),
}));

mock.module("@/stores/resolved-assistants-store", () => {
  const store = () => null;
  store.use = {
    activeAssistantId: () => "assistant-1",
  };
  return { useResolvedAssistantsStore: store };
});

const { HomeGuardianRequestCard } =
  await import("./home-guardian-request-card");

function guardianItem(
  projection: Partial<FeedItemGuardianRequest>,
  overrides: Partial<FeedItem> = {},
): FeedItem {
  return feedItem({
    id: "guardian:req-1",
    summary: "Alice asked the assistant to look up an issue",
    timestamp: "2026-08-31T12:00:00.000Z",
    createdAt: "2026-08-31T12:00:00.000Z",
    guardianRequest: {
      requestId: "req-1",
      kind: "tool_approval",
      intent: "approval",
      status: "pending",
      ...projection,
    },
    ...overrides,
  });
}

beforeEach(() => {
  mutateCalls.length = 0;
});

describe("HomeGuardianRequestCard", () => {
  test("a pending approval submits the canonical decision on Approve", () => {
    render(
      createElement(HomeGuardianRequestCard, {
        item: guardianItem({
          requesterLabel: "Alice",
          toolName: "linear_graphql",
          sourceContextLabel: "Slack #user-feedback",
        }),
      }),
    );

    // The panel header names the request; the card leads with the ask.
    expect(screen.queryByText("Guardian action needed")).toBeNull();
    // Source context and requester share the meta line under the title.
    expect(screen.getByText(/Slack #user-feedback · Alice/)).toBeTruthy();
    // A waiting request names the decision in the present tense.
    expect(screen.getByText("Requesting to run")).toBeTruthy();
    expect(screen.getByText("linear_graphql")).toBeTruthy();

    fireEvent.click(screen.getByText("Approve"));
    expect(mutateCalls).toEqual([
      {
        path: { assistant_id: "assistant-1" },
        body: { requestId: "req-1", action: "approve_once" },
      },
    ]);
  });

  test("Reject submits the reject action", () => {
    render(createElement(HomeGuardianRequestCard, { item: guardianItem({}) }));
    fireEvent.click(screen.getByText("Reject"));
    expect(mutateCalls[0]?.body?.action).toBe("reject");
  });

  test("a pending question offers no decision buttons, only the hint", () => {
    render(
      createElement(HomeGuardianRequestCard, {
        item: guardianItem({ intent: "question", kind: "pending_question" }),
      }),
    );
    expect(screen.queryByText("Approve")).toBeNull();
    expect(screen.queryByText("Reject")).toBeNull();
    expect(
      screen.getByText("Go to the conversation to answer this question."),
    ).toBeTruthy();
  });

  test("a question summary keeps its options on their own lines", () => {
    render(
      createElement(HomeGuardianRequestCard, {
        item: guardianItem(
          { intent: "question", kind: "pending_question" },
          { summary: "Which venue?\n\n1. The lodge\n2. The hotel" },
        ),
      }),
    );
    expect(screen.getByText("Which venue?")).toBeTruthy();
    expect(
      screen.getAllByRole("listitem").map((item) => item.textContent),
    ).toEqual(["The lodge", "The hotel"]);
  });

  const TERMINAL_RECEIPTS: [Partial<FeedItemGuardianRequest>, string][] = [
    [{ status: "approved", toolName: "linear_graphql" }, "Request approved"],
    [{ status: "denied" }, "Request rejected"],
    [{ status: "expired" }, "Request expired"],
    [{ status: "cancelled" }, "Request cancelled"],
    [
      {
        status: "denied",
        terminalReason: GUARDIAN_TERMINAL_REASON_SUPERSEDED,
      },
      "Request superseded",
    ],
    [
      { status: "denied", decidedAction: "leave_unverified" },
      "Left unverified",
    ],
  ];

  test.each(TERMINAL_RECEIPTS)(
    "a terminal projection renders its receipt and no buttons",
    (projection, expected) => {
      render(
        createElement(HomeGuardianRequestCard, {
          item: guardianItem(projection),
        }),
      );
      expect(
        screen.getByTestId("guardian-request-receipt").textContent,
      ).toContain(expected);
      expect(screen.queryByText("Approve")).toBeNull();
      expect(screen.queryByText("Reject")).toBeNull();
      // A settled request states the decision in the past tense. Only the
      // approved case carries a tool, so the tense is asserted there.
      if (projection.toolName) {
        expect(screen.getByText(/Requested to run/)).toBeTruthy();
        expect(screen.queryByText(/Requesting to run/)).toBeNull();
      }
    },
  );

  test("an item with no projection falls back to the summary", () => {
    render(
      createElement(HomeGuardianRequestCard, {
        item: feedItem({
          id: "notif:legacy",
          summary: "A legacy permission item",
          timestamp: "2026-08-31T12:00:00.000Z",
          createdAt: "2026-08-31T12:00:00.000Z",
        }),
      }),
    );
    expect(screen.getByText("A legacy permission item")).toBeTruthy();
    expect(screen.queryByText("Approve")).toBeNull();
  });
});
