/**
 * The retro card's two load-bearing behaviours: it pages, and every page a
 * user taps past still lands on an answer.
 *
 * Both are things a static render cannot show. The height complaint that
 * produced this card is only fixed if the questions really are on separate
 * pages, and the "all optional" promise is only kept if skipping submits a
 * default rather than a hole — and the gate's default has to be the cautious
 * option rather than the one the recording showed.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, render, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";

import type { Surface } from "@/domains/chat/types/types";
import { WatchRetroSurface } from "@/domains/chat/components/surfaces/watch-retro-surface";

afterEach(() => {
  cleanup();
});

function surface(overrides: Record<string, unknown> = {}): Surface {
  return {
    surfaceId: "surface-watch-1",
    surfaceType: "watch_retro",
    data: {
      task: "Filing a Linear bug from a Sentry alert",
      purpose: "So an overnight crash has a ticket by morning.",
      eyebrow: "Watched 4 min · 11 screens",
      steps: ["Open the Sentry issue", "New Linear issue in JARVIS"],
      questions: [
        {
          id: "trigger",
          kind: "fill",
          prompt: "What would you say to start this?",
          suggestion: "file this Sentry bug",
        },
        {
          id: "priority",
          kind: "pick",
          prompt: "You set this one to High. What decides that?",
          options: [
            { id: "events", label: "Over 100 events", note: "my reading" },
            { id: "customer", label: "It hit a customer" },
          ],
        },
        {
          id: "resolve",
          kind: "gate",
          prompt: "Resolving the Sentry issue — on my own?",
          options: [
            { id: "ask", label: "Ask me first" },
            { id: "go", label: "Go ahead" },
          ],
        },
      ],
      ...overrides,
    },
  } as Surface;
}

describe("WatchRetroSurface", () => {
  test("opens on the record, with no question beside it", () => {
    render(
      <WatchRetroSurface surface={surface()} onAction={() => undefined} />,
    );

    expect(
      screen.getByText("Filing a Linear bug from a Sentry alert"),
    ).toBeDefined();
    expect(screen.getByText("Open the Sentry issue")).toBeDefined();
    // The whole point of paging: a question the old card stacked underneath
    // the steps is not on this page at all.
    expect(screen.queryByText("What would you say to start this?")).toBeNull();
    expect(
      screen.queryByText("Resolving the Sentry issue — on my own?"),
    ).toBeNull();
  });

  test("submits a default for every page the user skips", async () => {
    const calls: { actionId: string; data?: Record<string, unknown> }[] = [];
    render(
      <WatchRetroSurface
        surface={surface()}
        onAction={(_surfaceId, actionId, data) => {
          calls.push({ actionId, data });
        }}
      />,
    );

    // Past the record, then skip all three questions.
    fireEvent.click(screen.getByText("That's it"));
    fireEvent.click(screen.getByText("Skip"));
    fireEvent.click(screen.getByText("Skip"));
    fireEvent.click(screen.getByText("Skip"));

    expect(calls).toHaveLength(1);
    const answers = calls[0]!.data!.answers as {
      questionId: string;
      answer: string;
      optionId?: string;
      skipped: boolean;
    }[];
    expect(answers).toHaveLength(3);

    // A skipped `fill` keeps its suggestion, so the model gets a working
    // trigger phrase rather than an empty string it has to guess around.
    expect(answers[0]).toMatchObject({
      questionId: "trigger",
      answer: "file this Sentry bug",
      skipped: true,
    });
    // A skipped `pick` takes the first option: the reading the recording
    // already supports, so accepting it is the status quo.
    expect(answers[1]).toMatchObject({
      questionId: "priority",
      optionId: "events",
      skipped: true,
    });
    // A skipped `gate` takes the first option too, and on a gate that has to
    // be the cautious one. Watching someone resolve an issue once is not
    // agreement to have it resolved again unattended, so tapping through the
    // card must never hand over the destructive step.
    expect(answers[2]).toMatchObject({
      questionId: "resolve",
      optionId: "ask",
      skipped: true,
    });
  });

  test("commits a pick on tap and moves to the next page", () => {
    const calls: { actionId: string; data?: Record<string, unknown> }[] = [];
    render(
      <WatchRetroSurface
        surface={surface()}
        onAction={(_surfaceId, actionId, data) => {
          calls.push({ actionId, data });
        }}
      />,
    );

    fireEvent.click(screen.getByText("That's it"));
    fireEvent.click(screen.getByText("Next"));
    // A single-select surface commits on tap everywhere else in the app, so
    // the pick page carries no advance button — the option is the gesture.
    fireEvent.click(screen.getByText("It hit a customer"));

    expect(calls).toHaveLength(0);
    expect(
      screen.getByText("Resolving the Sentry issue — on my own?"),
    ).toBeDefined();

    fireEvent.click(screen.getByText("Go ahead"));
    const answers = calls[0]!.data!.answers as {
      questionId: string;
      optionId?: string;
      skipped: boolean;
    }[];
    expect(answers[1]).toMatchObject({
      questionId: "priority",
      optionId: "customer",
      skipped: false,
    });
    expect(answers[2]).toMatchObject({ questionId: "resolve", optionId: "go" });
  });

  test("renders a question-less recording as a one-page card", () => {
    const calls: string[] = [];
    render(
      <WatchRetroSurface
        surface={surface({ questions: [] })}
        onAction={(_surfaceId, actionId) => {
          calls.push(actionId);
        }}
      />,
    );

    // Nothing was left open, so the record is the whole card and its button
    // saves rather than advancing to a page that does not exist.
    fireEvent.click(screen.getByText("Save skill"));
    expect(calls).toEqual(["answer"]);
  });

  test("drops a pick that carries nothing to pick from", () => {
    render(
      <WatchRetroSurface
        surface={surface({
          questions: [
            { id: "bare", kind: "pick", prompt: "What decides this?" },
          ],
        })}
        onAction={() => undefined}
      />,
    );

    // The surface schema is tolerant by design, so a question that parsed but
    // cannot be operated is filtered here. A one-option page would be a page
    // with no way off it; the record still renders.
    fireEvent.click(screen.getByText("Save skill"));
    expect(screen.queryByText("What decides this?")).toBeNull();
  });
});
