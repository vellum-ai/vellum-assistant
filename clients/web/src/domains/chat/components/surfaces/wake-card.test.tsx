/**
 * Tests for the wake card's transcript treatment: recap on the card, the rest
 * behind "View details".
 *
 * What the card must NOT show is as much the point as what it shows, so the
 * run detail and the source are asserted absent rather than only the recap
 * asserted present.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { CardSurface } from "@/domains/chat/components/surfaces/card-surface";
import type { Surface } from "@/domains/chat/types/types";
import { useViewerStore } from "@/stores/viewer-store";

const WAKE_BODY = [
  '[workflow "Classify observed subscriber use cases" completed]',
  "Run 387bfa70-4ba4-47be-b223-10922bf740cc finished with status: completed.",
  "Agents spawned: 1. Tokens: 608 in / 213 out.",
].join("\n");

function wakeSurface(): Surface {
  return {
    surfaceId: "wake-conv-1-1757000000000",
    surfaceType: "card",
    title: "Conversation Woke",
    data: {
      title: "Conversation Woke",
      body: WAKE_BODY,
      metadata: [{ label: "Source", value: "workflow_completed" }],
    },
  } as unknown as Surface;
}

afterEach(() => {
  cleanup();
  useViewerStore.getState().closeWakeDetail();
});

describe("wake card", () => {
  test("titles the card by what woke it, not by the wake", () => {
    render(<CardSurface surface={wakeSurface()} onAction={() => {}} />);

    // THEN the trigger names the card, and the daemon's own title is gone
    screen.getByText("Workflow finished");
    expect(screen.queryByText("Conversation Woke")).toBeNull();
  });

  test("falls back to a true generic title for an unlisted source", () => {
    const surface = wakeSurface();
    surface.data = {
      ...(surface.data as Record<string, unknown>),
      metadata: [{ label: "Source", value: "something-new" }],
    } as never;

    render(<CardSurface surface={surface} onAction={() => {}} />);

    screen.getByText("Ran on its own");
  });

  test("shows the recap instead of the raw hint", () => {
    // WHEN a wake card renders
    const { container } = render(
      <CardSurface surface={wakeSurface()} onAction={() => {}} />,
    );

    // THEN the workflow's own name stands alone, without the run detail and
    // without repeating the category the title already carries
    screen.getByText("Classify observed subscriber use cases");
    expect(container.innerHTML).not.toContain("387bfa70");
    expect(container.innerHTML).not.toContain("Tokens");
  });

  test("keeps the source off the card", () => {
    render(<CardSurface surface={wakeSurface()} onAction={() => {}} />);

    expect(screen.queryByText("Source")).toBeNull();
    expect(screen.queryByText("workflow_completed")).toBeNull();
  });

  test("draws no border, unlike its sibling surfaces", () => {
    const { container } = render(
      <CardSurface surface={wakeSurface()} onAction={() => {}} />,
    );

    expect(container.querySelector(".border-transparent")).not.toBeNull();
  });

  test("View details hands the whole payload to the side panel", () => {
    // GIVEN a rendered wake card
    render(<CardSurface surface={wakeSurface()} onAction={() => {}} />);

    // WHEN the user asks for the detail
    fireEvent.click(screen.getByText("View details"));

    // THEN the panel opens holding what the card left out
    const viewer = useViewerStore.getState();
    expect(viewer.mainView).toBe("wake-detail");
    expect(viewer.activeWakeDetail?.body).toContain("387bfa70");
    expect(viewer.activeWakeDetail?.metadata).toEqual([
      { label: "Source", value: "workflow_completed" },
    ]);
    // The panel is titled the same way the card is, so the two agree.
    expect(viewer.activeWakeDetail?.title).toBe("Workflow finished");
  });

  test("closing the panel restores the view behind it", () => {
    render(<CardSurface surface={wakeSurface()} onAction={() => {}} />);
    fireEvent.click(screen.getByText("View details"));

    useViewerStore.getState().closeWakeDetail();

    expect(useViewerStore.getState().mainView).toBe("chat");
    expect(useViewerStore.getState().activeWakeDetail).toBeNull();
  });

  test("a card that is not a wake keeps its metadata and body", () => {
    // GIVEN an ordinary card surface carrying the same shape
    const surface = {
      surfaceId: "card-access-request",
      surfaceType: "card",
      data: {
        title: "Access Request",
        body: "Alice asked for access.",
        metadata: [{ label: "Source", value: "Slack" }],
      },
    } as unknown as Surface;

    render(<CardSurface surface={surface} onAction={() => {}} />);

    // THEN nothing is folded away
    screen.getByText("Alice asked for access.");
    screen.getByText("Source");
    screen.getByText("Slack");
    expect(screen.queryByText("View details")).toBeNull();
  });
});
