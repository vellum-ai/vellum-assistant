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

// The decision hook refreshes the feed after every outcome, which needs a
// query client the card has no provider for. The mocked mutation above never
// settles, so no outcome (and no toast) is ever reached from here.
mock.module("@/domains/home/hooks/use-home-feed-query", () => ({
  useInvalidateHomeFeed: () => () => {},
}));

mock.module("@/stores/resolved-assistants-store", () => {
  const store = () => null;
  store.use = {
    activeAssistantId: () => "assistant-1",
  };
  return { useResolvedAssistantsStore: store };
});

const { HomeGuardianRequestCard } = await import(
  "./home-guardian-request-card"
);
const { useGuardianDecisionStore } = await import("../guardian-decision-store");

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
  useGuardianDecisionStore.getState().reset();
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

  test("an access request offers its card's decisions and submits Trust", () => {
    render(
      createElement(HomeGuardianRequestCard, {
        item: guardianItem({
          kind: "access_request",
          decisionActions: [
            { id: "trust", emphasis: "primary" },
            { id: "leave_unverified", emphasis: "secondary" },
            { id: "block", emphasis: "destructive" },
          ],
        }),
      }),
    );

    expect(screen.queryByText("Approve")).toBeNull();
    expect(screen.getByText("Leave unverified")).toBeTruthy();
    expect(screen.getByText("Block")).toBeTruthy();
    fireEvent.click(screen.getByText("Trust"));
    expect(mutateCalls[0]?.body?.action).toBe("trust");
  });

  test("Trust reads 'Trust anyway' beside a code handshake", () => {
    render(
      createElement(HomeGuardianRequestCard, {
        item: guardianItem({
          kind: "access_request",
          decisionActions: [
            { id: "verify_code", emphasis: "primary" },
            { id: "trust", emphasis: "secondary" },
            { id: "leave_unverified", emphasis: "secondary" },
            { id: "block", emphasis: "destructive" },
          ],
        }),
      }),
    );

    expect(screen.getByText("Verify with a code")).toBeTruthy();
    expect(screen.getByText("Trust anyway")).toBeTruthy();
  });

  test("a decision's reply shows on the card, with an approved receipt", () => {
    useGuardianDecisionStore.getState().recordOutcome({
      requestId: "req-1",
      action: "verify_code",
      committed: true,
      applied: true,
      replyText:
        "Access approved for Alice. Give them this verification code: `424242`.",
    });
    render(
      createElement(HomeGuardianRequestCard, {
        item: guardianItem({ kind: "access_request" }),
      }),
    );

    expect(
      screen.getByTestId("guardian-request-decision-reply").textContent,
    ).toContain("424242");
    expect(screen.getByText("Request approved")).toBeTruthy();
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
