/**
 * The card's two load-bearing behaviours: it pages, and every page a user taps
 * past still lands on an answer.
 *
 * Neither is visible to a static render. The card is only short if the
 * questions really are on separate pages, and "every question is optional" only
 * holds if skipping submits a default rather than a hole, with the gate
 * defaulting to the cautious option rather than to what the recording showed.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { CardSurface } from "@/domains/chat/components/surfaces/card-surface";
import type { Surface } from "@/domains/chat/types/types";

afterEach(() => {
  cleanup();
});

/**
 * Rendered through `CardSurface` rather than by importing the component
 * directly, because the template dispatch is part of what is under test: the
 * retro rides an ordinary `card`, and a renderer that does not match the
 * template has to fall through to a readable card rather than an error.
 */
function surface(
  templateOverrides: Record<string, unknown> = {},
  dataOverrides: Record<string, unknown> = {},
): Surface {
  return {
    surfaceId: "surface-watch-1",
    surfaceType: "card",
    data: {
      title: "Filing a Linear bug from a Sentry alert",
      subtitle: "So an overnight crash has a ticket by morning.",
      body: "1. Open the Sentry issue\n2. New Linear issue in JARVIS",
      template: "watch_retro",
      templateData: {
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
            prompt: "Resolving the Sentry issue, on my own?",
            options: [
              { id: "ask", label: "Ask me first" },
              { id: "go", label: "Go ahead" },
            ],
          },
        ],
        ...templateOverrides,
      },
      ...dataOverrides,
    },
  } as Surface;
}

describe("WatchRetroSurface", () => {
  test("opens on the record, with no question beside it", () => {
    render(<CardSurface surface={surface()} onAction={() => undefined} />);

    expect(
      screen.getByText("Filing a Linear bug from a Sentry alert"),
    ).toBeDefined();
    expect(screen.getByText("Open the Sentry issue")).toBeDefined();
    // The whole point of paging: a question the old card stacked underneath
    // the steps is not on this page at all.
    expect(screen.queryByText("What would you say to start this?")).toBeNull();
    expect(
      screen.queryByText("Resolving the Sentry issue, on my own?"),
    ).toBeNull();
  });

  test("submits a default for every page the user skips", async () => {
    const calls: { actionId: string; data?: Record<string, unknown> }[] = [];
    render(
      <CardSurface
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
    // A `card` is not one-shot daemon-side, so the card has to ask to be
    // completed or it stays answerable after it has been answered.
    expect(calls[0]!.data!._completeSurface).toBe(true);
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
      <CardSurface
        surface={surface()}
        onAction={(_surfaceId, actionId, data) => {
          calls.push({ actionId, data });
        }}
      />,
    );

    fireEvent.click(screen.getByText("That's it"));
    fireEvent.click(screen.getByText("Next"));
    // A single-select surface commits on tap everywhere else in the app, so
    // the pick page carries no advance button: the option is the gesture.
    fireEvent.click(screen.getByText("It hit a customer"));

    expect(calls).toHaveLength(0);
    expect(
      screen.getByText("Resolving the Sentry issue, on my own?"),
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
      <CardSurface
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

  test("falls back to a readable card when the template is not recognized", () => {
    // Exactly the path an older renderer takes: it has no `watch_retro` branch,
    // so the surface falls through to the plain card. The macOS app ships its
    // own renderer and floats its CLI to npm `latest`, so that client is a real
    // one, and the retro is the whole of what a finished session gives the
    // user. Dropping the template here reproduces its code path.
    render(
      <CardSurface
        surface={surface({}, { template: undefined })}
        onAction={() => undefined}
      />,
    );

    expect(
      screen.getByText("Filing a Linear bug from a Sentry alert"),
    ).toBeDefined();
    expect(
      screen.getByText("So an overnight crash has a ticket by morning."),
    ).toBeDefined();
    expect(screen.getByText(/Open the Sentry issue/)).toBeDefined();
    // Never the dead end a bespoke surface type would have produced.
    expect(screen.queryByText(/Unsupported surface type/)).toBeNull();
  });

  test("stays usable when a submission fails", async () => {
    let attempts = 0;
    render(
      <CardSurface
        surface={surface({ questions: [] })}
        onAction={() => {
          attempts += 1;
          // What a failed submit looks like from here: `handleSurfaceAction`
          // reports the error to the user and returns normally rather than
          // rejecting, so a reset that only ran on a thrown error would never
          // run. Every control would stay disabled behind an interactive
          // surface nobody can answer, with the composer blocked with it.
          return Promise.resolve();
        }}
      />,
    );

    const save = screen.getByText("Save skill");
    fireEvent.click(save);
    await waitFor(() => {
      expect(save.closest("button")!.disabled).toBe(false);
    });

    fireEvent.click(save);
    expect(attempts).toBe(2);
  });

  test("keeps one page per question id when the payload repeats one", () => {
    const calls: { data?: Record<string, unknown> }[] = [];
    render(
      <CardSurface
        surface={surface({
          questions: [
            {
              id: "same",
              kind: "pick",
              prompt: "First question",
              options: [
                { id: "a", label: "First A" },
                { id: "b", label: "First B" },
              ],
            },
            {
              id: "same",
              kind: "pick",
              prompt: "Second question",
              options: [
                { id: "c", label: "Second C" },
                { id: "d", label: "Second D" },
              ],
            },
          ],
        })}
        onAction={(_surfaceId, _actionId, data) => {
          calls.push({ data });
        }}
      />,
    );

    // Answers are held under the question id, so two questions sharing one
    // would share a slot: answering either would overwrite the other, and both
    // would submit whichever answer landed last. The first use of an id wins.
    fireEvent.click(screen.getByText("That's it"));
    expect(screen.getByText("First question")).toBeDefined();
    expect(screen.queryByText("Second question")).toBeNull();

    fireEvent.click(screen.getByText("First B"));
    const answers = calls[0]!.data!.answers as { optionId?: string }[];
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ optionId: "b" });
  });

  test("drops a pick that carries nothing to pick from", () => {
    render(
      <CardSurface
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

  /**
   * What a payload with the question text under the wrong key degrades to.
   *
   * `watch_retro_report` refuses this shape now, so it should not reach a
   * card. If one ever does, the record is still the half the user is owed, and
   * a question with no text is dropped the same way an optionless one is. The
   * schema is what makes that possible: an absent required string parses as
   * blank rather than as the word "undefined", which used to render.
   */
  test("a question whose text arrived under the wrong key leaves the record intact", () => {
    render(
      <CardSurface
        surface={surface({
          questions: [
            {
              id: "scope",
              kind: "pick",
              question: "Where does this routine end?",
              options: [
                { value: "Just read" },
                { value: "Also draft or send replies" },
              ],
            },
          ],
        })}
        onAction={() => undefined}
      />,
    );

    expect(
      screen.getByText("Filing a Linear bug from a Sentry alert"),
    ).toBeDefined();
    expect(screen.getByText("Open the Sentry issue")).toBeDefined();
    expect(screen.queryByText("undefined")).toBeNull();
    // Dropped rather than drawn: the record page is the only page, so it
    // carries the closing button rather than a hand-off to a blank question.
    expect(screen.getByText("Save skill")).toBeDefined();
  });
});
