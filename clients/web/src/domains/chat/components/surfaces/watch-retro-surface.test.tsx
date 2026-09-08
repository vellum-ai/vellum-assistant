/**
 * The card's load-bearing behaviours: it pages, a pick or a gate is answered
 * by the user rather than for them, and the card says when it is done.
 *
 * None of them is visible to a static render. The card is only short if the
 * questions really are on separate pages; an answer is only the user's if no
 * option starts selected and the page cannot be left without a tap; and a
 * submitted card only reads as submitted if the completed surface draws
 * something other than the page it was on.
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

  test("a skipped fill keeps its suggestion, and a tapped pick is the user's", async () => {
    const calls: { actionId: string; data?: Record<string, unknown> }[] = [];
    render(
      <CardSurface
        surface={surface()}
        onAction={(_surfaceId, actionId, data) => {
          calls.push({ actionId, data });
        }}
      />,
    );

    // Past the recap, skip the trigger, then answer the pick and the gate by
    // tapping their recommended option. That lands on the summary without
    // submitting: saving is its own act, asked for there and nowhere else.
    fireEvent.click(screen.getByText("Looks right"));
    fireEvent.click(screen.getByText("Skip"));
    fireEvent.click(screen.getByText("Over 100 events"));
    fireEvent.click(screen.getByText("Ask me first"));
    expect(calls).toHaveLength(0);

    fireEvent.click(screen.getByText("Save skill"));
    expect(calls).toHaveLength(1);
    // A `card` is not one-shot daemon-side, so the card has to ask to be
    // completed or it stays answerable after it has been answered. The summary
    // rides along so history restores what happened rather than "Completed".
    expect(calls[0]!.data!._completeSurface).toBe(true);
    expect(calls[0]!.data!._completionSummary).toBe("Skill saved");
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
    // Tapping the recommended option is still a choice: it goes out as the
    // user's answer, not as an accepted default.
    expect(answers[1]).toMatchObject({
      questionId: "priority",
      optionId: "events",
      skipped: false,
    });
    expect(answers[2]).toMatchObject({
      questionId: "resolve",
      optionId: "ask",
      skipped: false,
    });
  });

  test("a pick starts with nothing selected, the first option marked, and no way past it but a tap", () => {
    render(<CardSurface surface={surface()} onAction={() => undefined} />);

    fireEvent.click(screen.getByText("Looks right"));
    fireEvent.click(screen.getByText("Next"));
    expect(
      screen.getByText("You set this one to High. What decides that?"),
    ).toBeDefined();

    // Nothing is preselected: the recommendation is marked, not chosen.
    const options = screen.getAllByRole("button", { pressed: false });
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining("Over 100 events"),
      expect.stringContaining("It hit a customer"),
    ]);
    expect(screen.queryAllByRole("button", { pressed: true })).toHaveLength(0);
    // The recommendation is visible without being the answer.
    expect(options[0]!.textContent).toContain("Recommended");
    expect(options[1]!.textContent).not.toContain("Recommended");

    // The page cannot be left forward without answering.
    expect(screen.queryByText("Skip")).toBeNull();
    expect(screen.queryByText("Next")).toBeNull();
  });

  test("a pick revisited with an answer standing can be left with Next", () => {
    render(<CardSurface surface={surface()} onAction={() => undefined} />);

    fireEvent.click(screen.getByText("Looks right"));
    fireEvent.click(screen.getByText("Next"));
    fireEvent.click(screen.getByText("It hit a customer"));
    expect(
      screen.getByText("Resolving the Sentry issue, on my own?"),
    ).toBeDefined();

    // Back on the pick, the answer is still marked, and Next has appeared so
    // moving on does not mean tapping the same option again.
    fireEvent.click(screen.getByText("Back"));
    const chosen = screen.getByRole("button", { pressed: true });
    expect(chosen.textContent).toContain("It hit a customer");
    fireEvent.click(screen.getByText("Next"));
    expect(
      screen.getByText("Resolving the Sentry issue, on my own?"),
    ).toBeDefined();
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

    fireEvent.click(screen.getByText("Looks right"));
    fireEvent.click(screen.getByText("Next"));
    // The option is the gesture: a tap answers and advances in one.
    fireEvent.click(screen.getByText("It hit a customer"));

    expect(calls).toHaveLength(0);
    expect(
      screen.getByText("Resolving the Sentry issue, on my own?"),
    ).toBeDefined();

    fireEvent.click(screen.getByText("Go ahead"));
    // The gate was the last question, so this lands on the summary rather than
    // submitting. Saving is the explicit act.
    expect(calls).toHaveLength(0);
    fireEvent.click(screen.getByText("Save skill"));
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

  test("goes back a page, and back to any page already visited", () => {
    render(<CardSurface surface={surface()} onAction={() => undefined} />);

    fireEvent.click(screen.getByText("Looks right"));
    expect(screen.getByText("What would you say to start this?")).toBeDefined();

    // Back steps one page at a time.
    fireEvent.click(screen.getByText("Back"));
    expect(
      screen.getByText("Filing a Linear bug from a Sentry alert"),
    ).toBeDefined();

    // The step row jumps further than one page: a decision made three pages
    // ago is one tap away rather than a restart. Only visited steps are
    // navigable, which is what makes the row safe to expose.
    fireEvent.click(screen.getByText("Looks right"));
    fireEvent.click(screen.getByText("Next"));
    expect(
      screen.getByText("You set this one to High. What decides that?"),
    ).toBeDefined();
    fireEvent.click(screen.getByText("Recap"));
    expect(
      screen.getByText("Filing a Linear bug from a Sentry alert"),
    ).toBeDefined();
  });

  test("an answer changed from the summary is the one submitted", () => {
    const calls: { data?: Record<string, unknown> }[] = [];
    render(
      <CardSurface
        surface={surface()}
        onAction={(_surfaceId, _actionId, data) => {
          calls.push({ data });
        }}
      />,
    );

    fireEvent.click(screen.getByText("Looks right"));
    fireEvent.click(screen.getByText("Next"));
    fireEvent.click(screen.getByText("Over 100 events"));
    fireEvent.click(screen.getByText("Ask me first"));

    // On the summary, every line is the answer to something asked earlier and
    // goes back to where it was asked. Changing one there has to reach the
    // payload, or the review step would be decoration. These questions carry
    // no `eyebrow`, so the row is titled by the prompt, which is the fallback.
    fireEvent.click(
      screen.getByText("You set this one to High. What decides that?"),
    );
    fireEvent.click(screen.getByText("It hit a customer"));
    fireEvent.click(screen.getByText("Save skill"));

    const answers = calls[0]!.data!.answers as {
      questionId: string;
      optionId?: string;
    }[];
    expect(answers[1]).toMatchObject({
      questionId: "priority",
      optionId: "customer",
    });
  });

  test("the session can only be dropped from the summary", () => {
    const calls: string[] = [];
    render(
      <CardSurface
        surface={surface()}
        onAction={(_surfaceId, actionId) => {
          calls.push(actionId);
        }}
      />,
    );

    // Nothing destructive while the user is still reading what they have.
    expect(screen.queryByText("Don't save")).toBeNull();

    fireEvent.click(screen.getByText("Looks right"));
    fireEvent.click(screen.getByText("Skip"));
    fireEvent.click(screen.getByText("Over 100 events"));
    fireEvent.click(screen.getByText("Ask me first"));

    fireEvent.click(screen.getByText("Don't save"));
    expect(calls).toEqual(["discard"]);
  });

  test("a completed surface collapses to one row saying what happened", () => {
    const { rerender } = render(
      <CardSurface surface={surface()} onAction={() => undefined} />,
    );
    expect(screen.getByText("Looks right")).toBeDefined();

    // What `completeSubmittedSurface` does the moment a submit is accepted:
    // completed, with no summary until the daemon's completion event lands.
    rerender(
      <CardSurface
        surface={{ ...surface(), completed: true }}
        onAction={() => undefined}
      />,
    );
    expect(screen.queryByText("Looks right")).toBeNull();
    expect(screen.queryByText("Open the Sentry issue")).toBeNull();
    expect(
      screen.getByText("Filing a Linear bug from a Sentry alert"),
    ).toBeDefined();
    expect(screen.getByText("Done")).toBeDefined();

    // The summary the card sent is what the daemon echoes back and what a
    // restored conversation carries. It is matched back to its ending and
    // drawn from the catalog, so the row reads in the viewer's locale rather
    // than the locale of whoever answered.
    rerender(
      <CardSurface
        surface={{
          ...surface(),
          completed: true,
          completionSummary: "Flagged as not right",
        }}
        onAction={() => undefined}
      />,
    );
    expect(screen.getByText("Flagged as not right")).toBeDefined();
    expect(screen.queryByText("Done")).toBeNull();
  });

  test("the ending submitted from this card names the row before the summary arrives", async () => {
    let current = surface();
    const { rerender } = render(
      <CardSurface
        surface={current}
        onAction={(_surfaceId, _actionId, data) => {
          // The optimistic completion: no summary yet, only the flag.
          expect(data!._completionSummary).toBe("Flagged as not right");
          current = { ...current, completed: true };
        }}
      />,
    );

    fireEvent.click(screen.getByText("Something's off"));
    rerender(<CardSurface surface={current} onAction={() => undefined} />);
    await waitFor(() => {
      expect(screen.getByText("Flagged as not right")).toBeDefined();
    });
    expect(screen.queryByText("Something's off")).toBeNull();

    // The daemon's summary is the ending that actually landed. When it
    // disagrees with what this mount submitted, because another client
    // answered the same card first, the summary wins.
    rerender(
      <CardSurface
        surface={{ ...current, completionSummary: "Skill saved" }}
        onAction={() => undefined}
      />,
    );
    expect(screen.getByText("Skill saved")).toBeDefined();
    expect(screen.queryByText("Flagged as not right")).toBeNull();
  });

  test("saying the recap read wrong ends the card without saving", () => {
    const calls: string[] = [];
    render(
      <CardSurface
        surface={surface()}
        onAction={(_surfaceId, actionId) => {
          calls.push(actionId);
        }}
      />,
    );

    // A correction rather than a refusal: the turn picks the action up and
    // asks what was off, so it does not go through the discard path.
    fireEvent.click(screen.getByText("Something's off"));
    expect(calls).toEqual(["not_right"]);
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
    fireEvent.click(screen.getByText("Looks right"));
    expect(screen.getByText("First question")).toBeDefined();
    expect(screen.queryByText("Second question")).toBeNull();

    fireEvent.click(screen.getByText("First B"));
    fireEvent.click(screen.getByText("Save skill"));
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
