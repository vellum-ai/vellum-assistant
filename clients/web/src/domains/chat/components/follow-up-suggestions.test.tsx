/**
 * Tests for the follow-up suggestion chips under the latest assistant reply.
 *
 * Three things are worth pinning. The gate, because it is what keeps the
 * surface from stacking a second set of buttons under a turn that already
 * asked the user something, or from offering a next message while one is still
 * being written. The click, because the chip's whole contract is that its
 * visible text is what gets sent. And what the surface reports: one impression
 * per reply however often it mounts, and a click that carries the chip's
 * position without its words.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// The emitters post through the generated client; mock the sdk function and
// assert on the request body the chips produce.
const ingestMock = mock(
  async (_options: { body: unknown; keepalive?: boolean }) => ({
    data: { accepted: 1, persisted: 1, dropped: {} },
    error: undefined,
    response: { ok: true, status: 200 } as Response,
  }),
);
mock.module("@/generated/api/sdk.gen", () => ({
  telemetryIngestCreate: ingestMock,
}));

// Analytics is opt-out, so a never-asked client uploads; pin that here rather
// than reaching into the onboarding store the chat domain must not import.
mock.module("@/lib/telemetry/consent", () => ({
  readAnalyticsConsent: () => true,
}));

const { FollowUpSuggestions, shouldShowFollowUpSuggestions } =
  await import("@/domains/chat/components/follow-up-suggestions");
const { __resetFollowUpSuggestionEventsForTests } =
  await import("@/domains/chat/follow-up-suggestion-events");

const SUGGESTIONS = ["Compare the two options", "Draft the summary"];

/** Identifies the reply under test; the chips report against it. */
const CONTEXT = {
  assistantId: "assistant-1",
  conversationId: "conv-xyz",
  messageId: "msg-123",
  ghostTextSuppressed: true,
};

/** The gate's inputs with nothing suppressing the chips. */
const OPEN = {
  enabled: true,
  suggestions: SUGGESTIONS,
  turnActive: false,
  awaitingInteraction: false,
};

/** The events one ingest call carried. */
function sentEvents(callIndex: number): Array<Record<string, unknown>> {
  const options = ingestMock.mock.calls[callIndex]?.[0] as
    | { body: { events: Array<Record<string, unknown>> } }
    | undefined;
  if (!options) {
    throw new Error(`No ingest call at index ${callIndex}`);
  }
  return options.body.events;
}

beforeEach(() => {
  __resetFollowUpSuggestionEventsForTests();
  ingestMock.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("shouldShowFollowUpSuggestions", () => {
  test("shows the chips when the flag is on and the turn has settled", () => {
    expect(shouldShowFollowUpSuggestions(OPEN)).toBe(true);
  });

  test("shows nothing when the flag is off", () => {
    expect(shouldShowFollowUpSuggestions({ ...OPEN, enabled: false })).toBe(
      false,
    );
  });

  test("shows nothing while the turn is still running", () => {
    expect(shouldShowFollowUpSuggestions({ ...OPEN, turnActive: true })).toBe(
      false,
    );
  });

  test("shows nothing when the turn ended on a surface awaiting an answer", () => {
    // A choice surface or an `ask_question` card renders its own buttons, so
    // chips underneath would offer a second way to answer one question.
    expect(
      shouldShowFollowUpSuggestions({ ...OPEN, awaitingInteraction: true }),
    ).toBe(false);
  });

  test("shows nothing when the daemon returned no suggestions", () => {
    expect(shouldShowFollowUpSuggestions({ ...OPEN, suggestions: [] })).toBe(
      false,
    );
  });
});

describe("FollowUpSuggestions", () => {
  test("renders one chip per suggestion inside a labelled group", () => {
    render(
      <FollowUpSuggestions
        suggestions={SUGGESTIONS}
        onSelect={() => {}}
        context={CONTEXT}
      />,
    );

    const group = screen.getByRole("group", { name: "Suggested follow-ups" });
    const chips = group.querySelectorAll("button");
    expect([...chips].map((chip) => chip.textContent)).toEqual(SUGGESTIONS);
  });

  test("sends the picked chip's own text", () => {
    const sent: string[] = [];
    render(
      <FollowUpSuggestions
        suggestions={SUGGESTIONS}
        onSelect={(suggestion) => sent.push(suggestion)}
        context={CONTEXT}
      />,
    );

    fireEvent.click(screen.getByText("Draft the summary"));

    expect(sent).toEqual(["Draft the summary"]);
  });

  test("drops anything past the second suggestion", () => {
    render(
      <FollowUpSuggestions
        suggestions={[...SUGGESTIONS, "Third one"]}
        onSelect={() => {}}
        context={CONTEXT}
      />,
    );

    expect(screen.queryByText("Third one")).toBeNull();
    expect(screen.getAllByRole("button").length).toBe(2);
  });

  test("renders nothing when there is nothing to suggest", () => {
    const { container } = render(
      <FollowUpSuggestions
        suggestions={[]}
        onSelect={() => {}}
        context={CONTEXT}
      />,
    );

    expect(container.innerHTML).toBe("");
  });
});

describe("FollowUpSuggestions telemetry", () => {
  test("reports one impression carrying the reply's identity and positions", () => {
    render(
      <FollowUpSuggestions
        suggestions={SUGGESTIONS}
        onSelect={() => {}}
        context={CONTEXT}
      />,
    );

    expect(sentEvents(0)).toEqual([
      expect.objectContaining({
        type: "follow_up_suggestion_impression",
        daemon_event_id: "follow_up_suggestion:impression:msg-123",
        assistant_id: "assistant-1",
        conversation_id: "conv-xyz",
        message_id: "msg-123",
        ghost_text_suppressed: true,
        suggestion_count: 2,
        suggestion_indexes: [0, 1],
      }),
    ]);
  });

  test("reports one impression across two mounts of the same reply", () => {
    const chips = (
      <FollowUpSuggestions
        suggestions={SUGGESTIONS}
        onSelect={() => {}}
        context={CONTEXT}
      />
    );
    const first = render(chips);
    first.unmount();
    render(chips);

    expect(ingestMock).toHaveBeenCalledTimes(1);
  });

  test("reports nothing when no chip rendered", () => {
    render(
      <FollowUpSuggestions
        suggestions={[]}
        onSelect={() => {}}
        context={CONTEXT}
      />,
    );

    expect(ingestMock).not.toHaveBeenCalled();
  });

  test("reports a click with the chip's position and text length, not its text", () => {
    render(
      <FollowUpSuggestions
        suggestions={SUGGESTIONS}
        onSelect={() => {}}
        context={CONTEXT}
      />,
    );
    ingestMock.mockClear();

    fireEvent.click(screen.getByText("Draft the summary"));

    const [click] = sentEvents(0);
    expect(click).toMatchObject({
      type: "follow_up_suggestion_click",
      message_id: "msg-123",
      suggestion_index: 1,
      suggestion_length: "Draft the summary".length,
    });
    expect(JSON.stringify(click)).not.toContain("Draft the summary");
  });
});
