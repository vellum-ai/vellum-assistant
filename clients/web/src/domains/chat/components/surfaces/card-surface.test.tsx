import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CardSurface } from "@/domains/chat/components/surfaces/card-surface";
import type { Surface } from "@/domains/chat/types/types";

function surface(overrides: Partial<Surface> = {}): Surface {
  return {
    surfaceId: "surface-123",
    surfaceType: "card",
    title: "Response limit reached",
    data: {
      title: "Response limit reached",
      subtitle: "The partial response above was saved.",
      body: "I hit the response limit before I could finish.",
    },
    actions: [
      {
        id: "relay_prompt",
        label: "Continue",
        style: "primary",
        data: { prompt: "Continue from where you stopped." },
      },
    ],
    ...overrides,
  };
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

describe("CardSurface", () => {
  test("does not duplicate the card title when the surface envelope has the same title", () => {
    const rendered = renderToStaticMarkup(
      <CardSurface surface={surface()} onAction={() => undefined} />,
    );

    expect(countOccurrences(rendered, "Response limit reached")).toBe(1);
    expect(rendered).toContain("The partial response above was saved.");
    expect(rendered).toContain(
      "I hit the response limit before I could finish.",
    );
  });

  test("renders the card data title instead of the envelope title", () => {
    const rendered = renderToStaticMarkup(
      <CardSurface
        surface={surface({
          title: "Envelope title",
          data: {
            title: "Card title",
            subtitle: "Card subtitle",
            body: "Card body",
          },
        })}
        onAction={() => undefined}
      />,
    );

    expect(rendered).toContain("Card title");
    expect(rendered).not.toContain("Envelope title");
  });

  test("falls back to the envelope title when card data has no title", () => {
    const rendered = renderToStaticMarkup(
      <CardSurface
        surface={surface({
          title: "Envelope fallback",
          data: {
            subtitle: "Card subtitle",
            body: "Card body",
          },
        })}
        onAction={() => undefined}
      />,
    );

    expect(rendered).toContain("Envelope fallback");
    expect(countOccurrences(rendered, "Envelope fallback")).toBe(1);
  });

  test("does not render an error glyph for a failed step once the overall task completes", () => {
    const rendered = renderToStaticMarkup(
      <CardSurface
        surface={surface({
          title: "Connect Gmail",
          data: {
            title: "Connect Gmail",
            body: "",
            template: "task_progress",
            templateData: {
              title: "Connect Gmail",
              status: "completed",
              steps: [
                { label: "Verifying Gmail connection", status: "failed" },
                { label: "Finishing setup", status: "completed" },
              ],
            },
          },
        })}
        onAction={() => undefined}
      />,
    );

    // lucide CircleX renders an `<svg>` with the `lucide-circle-x` class; a
    // recovered step must not surface it.
    expect(rendered).not.toContain("lucide-circle-x");
    expect(rendered).toContain("Verifying Gmail connection");
  });

  test("still renders an error glyph for a failed step while the task is in progress", () => {
    const rendered = renderToStaticMarkup(
      <CardSurface
        surface={surface({
          title: "Connect Gmail",
          data: {
            title: "Connect Gmail",
            body: "",
            template: "task_progress",
            templateData: {
              title: "Connect Gmail",
              status: "in_progress",
              steps: [
                { label: "Verifying Gmail connection", status: "failed" },
              ],
            },
          },
        })}
        onAction={() => undefined}
      />,
    );

    expect(rendered).toContain("lucide-circle-x");
  });

  test("renders the counter progress bar when templateData has usable counters", () => {
    const rendered = renderToStaticMarkup(
      <CardSurface
        surface={surface({
          data: {
            title: "Processing files",
            body: "",
            template: "task_progress",
            templateData: { completed: 2, total: 5 },
          },
        })}
        onAction={() => undefined}
      />,
    );

    expect(rendered).toContain("2 / 5 tasks");
    expect(rendered).toContain("40%");
  });

  test("degrades to the plain card body when task_progress steps is not an array", () => {
    // Shape observed from MiniMax M3: arrays wrapped as { item: [...] }.
    // This fails isTaskProgressSurface, and there are no counters either —
    // the card must not render a meaningless "0 / 0 tasks" bar.
    const rendered = renderToStaticMarkup(
      <CardSurface
        surface={surface({
          title: "Building slide deck",
          data: {
            body: "Working on it.",
            template: "task_progress",
            templateData: {
              title: "Slide Deck",
              status: "in_progress",
              steps: { item: [{ label: "Research", status: "in_progress" }] },
            },
          },
        })}
        onAction={() => undefined}
      />,
    );

    expect(rendered).not.toContain("0 / 0 tasks");
    expect(rendered).not.toContain("tasks");
    expect(rendered).toContain("Building slide deck");
    expect(rendered).toContain("Working on it.");
  });

  test("does not render a counter bar when task_progress has neither steps nor counters", () => {
    const rendered = renderToStaticMarkup(
      <CardSurface
        surface={surface({
          data: {
            title: "Task",
            body: "Details",
            template: "task_progress",
            templateData: { title: "Task", status: "in_progress" },
          },
        })}
        onAction={() => undefined}
      />,
    );

    expect(rendered).not.toContain("tasks");
    expect(rendered).not.toContain("%");
    expect(rendered).toContain("Details");
  });

  test("status glyphs carry visually hidden labels for assistive tech", () => {
    const rendered = renderToStaticMarkup(
      <CardSurface
        surface={surface({
          title: "Connect Gmail",
          data: {
            title: "Connect Gmail",
            body: "",
            template: "task_progress",
            templateData: {
              title: "Connect Gmail",
              status: "completed",
              steps: [{ label: "Finishing setup", status: "waiting" }],
            },
          },
        })}
        onAction={() => undefined}
      />,
    );

    // The header glyph and each step glyph are icon-only; the sr-only label
    // is the only status text exposed to assistive tech.
    expect(rendered).toContain(">Completed</span>");
    expect(rendered).toContain("sr-only");
  });

  test("a body-less card renders its title (no loading spinner)", () => {
    const rendered = renderToStaticMarkup(
      <CardSurface
        surface={surface({
          title: "Heads up",
          data: { title: "Heads up" },
          actions: [],
        })}
        onAction={() => undefined}
      />,
    );

    // A title-only card is a valid card (the daemon recovers misplaced content
    // before it gets here); render the title, not a fake loading affordance.
    expect(rendered).toContain("Heads up");
    expect(rendered).not.toContain("animate-spin");
  });

  test("a title-only card with actions renders both title and actions", () => {
    const rendered = renderToStaticMarkup(
      <CardSurface
        surface={surface({
          title: "Restart the server?",
          data: { title: "Restart the server?" },
          actions: [{ id: "yes", label: "Yes", style: "primary" }],
        })}
        onAction={() => undefined}
      />,
    );

    expect(rendered).toContain("Restart the server?");
    expect(rendered).toContain("Yes");
  });

  test("a card with body and actions renders both", () => {
    const rendered = renderToStaticMarkup(
      <CardSurface
        surface={surface({
          title: "Confirm",
          data: { title: "Confirm", body: "Are you sure?" },
          actions: [{ id: "ok", label: "OK", style: "primary" }],
        })}
        onAction={() => undefined}
      />,
    );

    expect(rendered).toContain("Confirm");
    expect(rendered).toContain("Are you sure?");
    expect(rendered).toContain("OK");
  });
});

// ---------------------------------------------------------------------------
// Guardian trust-decision cards
// ---------------------------------------------------------------------------

/**
 * The Trust / Leave unverified / Block card as it comes back off conversation
 * history. A decided card carries `completed` + `completionSummary` on its
 * persisted `ui_surface` block, and those two fields alone must drive the
 * rendered state: re-entering the conversation renders from history, with none
 * of the acting session's in-memory optimistic state (LUM-2919).
 */
function trustDecisionCard(overrides: Partial<Surface> = {}): Surface {
  return {
    surfaceId: "access-request-req-123",
    surfaceType: "card",
    title: "Access Request",
    data: {
      title: "Alice",
      subtitle: "Requesting access to the assistant",
      body: '> "Hey, can you help me set up my project environment?"',
    },
    actions: [
      { id: "apr:req-123:trust", label: "Trust", style: "primary" },
      { id: "apr:req-123:leave_unverified", label: "Leave unverified" },
      { id: "apr:req-123:block", label: "Block", style: "destructive" },
    ],
    ...overrides,
  };
}

describe("CardSurface trust-decision rehydration", () => {
  test("an undecided card renders the three decision buttons", () => {
    const rendered = renderToStaticMarkup(
      <CardSurface surface={trustDecisionCard()} onAction={() => undefined} />,
    );

    expect(rendered).toContain(">Trust</button>");
    expect(rendered).toContain(">Leave unverified</button>");
    expect(rendered).toContain(">Block</button>");
  });

  test("a card rehydrated with a persisted decision renders that decision, not the buttons", () => {
    const rendered = renderToStaticMarkup(
      <CardSurface
        surface={trustDecisionCard({
          completed: true,
          completionSummary: "Left unverified",
        })}
        onAction={() => undefined}
      />,
    );

    expect(rendered).toContain("Left unverified");
    // The decision replaces the button group; the card body stays for the
    // audit trail.
    expect(rendered).not.toContain(">Trust</button>");
    expect(rendered).not.toContain(">Leave unverified</button>");
    expect(rendered).not.toContain(">Block</button>");
    expect(rendered).toContain("Alice");
  });

  test("a rehydrated park reads neutral, not as an affirmative success", () => {
    const rendered = renderToStaticMarkup(
      <CardSurface
        surface={trustDecisionCard({
          completed: true,
          completionSummary: "Left unverified",
        })}
        onAction={() => undefined}
      />,
    );

    // History carries only the summary string, so the tone is inferred from it.
    expect(rendered).toContain("lucide-circle-slash");
    expect(rendered).not.toContain("lucide-circle-check");
  });

  test("a rehydrated block reads as a rejection", () => {
    const rendered = renderToStaticMarkup(
      <CardSurface
        surface={trustDecisionCard({
          completed: true,
          completionSummary: "Denied",
        })}
        onAction={() => undefined}
      />,
    );

    expect(rendered).toContain("Denied");
    expect(rendered).toContain("lucide-circle-x");
  });

  test("a rehydrated trust reads as a success", () => {
    const rendered = renderToStaticMarkup(
      <CardSurface
        surface={trustDecisionCard({
          completed: true,
          completionSummary: "Approved",
        })}
        onAction={() => undefined}
      />,
    );

    expect(rendered).toContain("Approved");
    expect(rendered).toContain("lucide-circle-check");
  });
});
