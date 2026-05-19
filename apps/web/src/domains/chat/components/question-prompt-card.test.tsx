import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";

import type { QuestionEntry, QuestionResponseEntry } from "@/domains/chat/lib/api.js";
import { cleanup, render, screen } from "@/test-utils.js";
import userEvent from "@testing-library/user-event";

import { QuestionPromptCard } from "@/domains/chat/components/question-prompt-card.js";

const REQUEST_ID = "req-1";

function makeEntry(overrides: Partial<QuestionEntry> = {}): QuestionEntry {
  return {
    id: "q1",
    question: "Should I proceed?",
    description: "This will affect production.",
    options: [
      { id: "yes", label: "Yes, proceed" },
      { id: "no", label: "No, cancel", description: "Stop the operation" },
    ],
    freeTextPlaceholder: "Type your answer...",
    ...overrides,
  };
}

function threeEntries(): QuestionEntry[] {
  return [
    makeEntry({ id: "q1", question: "First?" }),
    makeEntry({
      id: "q2",
      question: "Second?",
      options: [
        { id: "a", label: "Alpha" },
        { id: "b", label: "Bravo" },
      ],
    }),
    makeEntry({
      id: "q3",
      question: "Third?",
      options: [
        { id: "x", label: "Xenon" },
        { id: "y", label: "Yttrium" },
      ],
    }),
  ];
}

describe("QuestionPromptCard — single entry", () => {
  afterEach(cleanup);

  it("renders the question text, option buttons, and the free-text input", () => {
    const onSubmitAll = mock(() => {});
    render(
      <QuestionPromptCard
        requestId={REQUEST_ID}
        entries={[makeEntry()]}
        isSubmitting={false}
        onSubmitAll={onSubmitAll}
      />,
    );

    expect(screen.getByText("Should I proceed?")).toBeInTheDocument();
    expect(screen.getByText("This will affect production.")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Option 1: Yes, proceed/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Option 2: No, cancel/ }),
    ).toBeInTheDocument();

    const input = screen.getByRole("textbox", {
      name: /type a different answer/i,
    });
    expect(input).toHaveAttribute("placeholder", "Type your answer...");
  });

  it("hides the pagination counter for a single entry but still renders disabled chevrons + X", () => {
    render(
      <QuestionPromptCard
        requestId={REQUEST_ID}
        entries={[makeEntry()]}
        isSubmitting={false}
        onSubmitAll={() => {}}
        onClose={() => {}}
      />,
    );

    expect(screen.queryByText(/1 of 1/i)).toBeNull();
    const prev = screen.getByRole("button", { name: /previous question/i });
    const next = screen.getByRole("button", { name: /next question/i });
    expect(prev).toBeDisabled();
    expect(next).toBeDisabled();
  });

  it("auto-submits a one-element batch when an option is tapped", async () => {
    const user = userEvent.setup();
    const onSubmitAll = mock((_responses: QuestionResponseEntry[]) => {});
    render(
      <QuestionPromptCard
        requestId={REQUEST_ID}
        entries={[makeEntry()]}
        isSubmitting={false}
        onSubmitAll={onSubmitAll}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /Option 1: Yes, proceed/ }),
    );
    expect(onSubmitAll).toHaveBeenCalledTimes(1);
    expect(onSubmitAll).toHaveBeenCalledWith([
      { questionId: "q1", kind: "option", optionId: "yes" },
    ]);
  });

  it("auto-submits on Enter inside the free-text input", async () => {
    const user = userEvent.setup();
    const onSubmitAll = mock((_responses: QuestionResponseEntry[]) => {});
    render(
      <QuestionPromptCard
        requestId={REQUEST_ID}
        entries={[makeEntry()]}
        isSubmitting={false}
        onSubmitAll={onSubmitAll}
      />,
    );

    const input = screen.getByRole("textbox", {
      name: /type a different answer/i,
    });
    await user.type(input, "Custom answer{Enter}");
    expect(onSubmitAll).toHaveBeenCalledTimes(1);
    expect(onSubmitAll).toHaveBeenCalledWith([
      { questionId: "q1", kind: "free_text", text: "Custom answer" },
    ]);
  });

  it("auto-submits a skip via the Skip button when no text is typed", async () => {
    const user = userEvent.setup();
    const onSubmitAll = mock((_responses: QuestionResponseEntry[]) => {});
    render(
      <QuestionPromptCard
        requestId={REQUEST_ID}
        entries={[makeEntry()]}
        isSubmitting={false}
        onSubmitAll={onSubmitAll}
      />,
    );

    await user.click(screen.getByRole("button", { name: /skip this question/i }));
    expect(onSubmitAll).toHaveBeenCalledTimes(1);
    expect(onSubmitAll).toHaveBeenCalledWith([{ questionId: "q1", kind: "skip" }]);
  });

  it("falls back to a generic placeholder when freeTextPlaceholder is omitted", () => {
    render(
      <QuestionPromptCard
        requestId={REQUEST_ID}
        entries={[makeEntry({ freeTextPlaceholder: undefined })]}
        isSubmitting={false}
        onSubmitAll={() => {}}
      />,
    );

    const input = screen.getByRole("textbox", {
      name: /type a different answer/i,
    });
    expect(input).toHaveAttribute("placeholder", "Type something else");
  });

  it("swaps Skip for Send the moment the input has text and submits via Send", async () => {
    const user = userEvent.setup();
    const onSubmitAll = mock((_responses: QuestionResponseEntry[]) => {});
    render(
      <QuestionPromptCard
        requestId={REQUEST_ID}
        entries={[makeEntry()]}
        isSubmitting={false}
        onSubmitAll={onSubmitAll}
      />,
    );

    expect(
      screen.getByRole("button", { name: /skip this question/i }),
    ).toBeInTheDocument();

    const input = screen.getByRole("textbox", {
      name: /type a different answer/i,
    });
    await user.type(input, "Custom answer");

    expect(screen.queryByRole("button", { name: /skip this question/i })).toBeNull();
    const send = screen.getByRole("button", { name: /send response/i });
    expect(send).not.toBeDisabled();
    await user.click(send);
    expect(onSubmitAll).toHaveBeenCalledTimes(1);
    expect(onSubmitAll).toHaveBeenCalledWith([
      { questionId: "q1", kind: "free_text", text: "Custom answer" },
    ]);
  });

  it("disables option buttons while the free-text input has text", async () => {
    const user = userEvent.setup();
    render(
      <QuestionPromptCard
        requestId={REQUEST_ID}
        entries={[makeEntry()]}
        isSubmitting={false}
        onSubmitAll={() => {}}
      />,
    );

    expect(
      screen.getByRole("button", { name: /Option 1: Yes, proceed/ }),
    ).not.toBeDisabled();

    await user.type(
      screen.getByRole("textbox", { name: /type a different answer/i }),
      "x",
    );

    expect(
      screen.getByRole("button", { name: /Option 1: Yes, proceed/ }),
    ).toBeDisabled();
  });

  it("does not submit on Enter when the input is whitespace-only", async () => {
    const user = userEvent.setup();
    const onSubmitAll = mock(() => {});
    render(
      <QuestionPromptCard
        requestId={REQUEST_ID}
        entries={[makeEntry()]}
        isSubmitting={false}
        onSubmitAll={onSubmitAll}
      />,
    );

    const input = screen.getByRole("textbox", {
      name: /type a different answer/i,
    });
    await user.type(input, "   {Enter}");
    expect(onSubmitAll).not.toHaveBeenCalled();
  });

  it("clears the inline input on Escape when there is text", async () => {
    const user = userEvent.setup();
    render(
      <QuestionPromptCard
        requestId={REQUEST_ID}
        entries={[makeEntry()]}
        isSubmitting={false}
        onSubmitAll={() => {}}
      />,
    );

    const input = screen.getByRole("textbox", {
      name: /type a different answer/i,
    }) as HTMLInputElement;
    await user.type(input, "halfway-typed");
    expect(input.value).toBe("halfway-typed");

    await user.keyboard("{Escape}");
    expect(input.value).toBe("");
  });

  it("disables option buttons, send button, and the input when isSubmitting is true", () => {
    render(
      <QuestionPromptCard
        requestId={REQUEST_ID}
        entries={[makeEntry()]}
        isSubmitting={true}
        onSubmitAll={() => {}}
      />,
    );

    expect(
      screen.getByRole("button", { name: /Option 1: Yes, proceed/ }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /Option 2: No, cancel/ }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /skip this question/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole("textbox", { name: /type a different answer/i }),
    ).toBeDisabled();
  });

  it("renders defensively and warns when zero entries are supplied", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const { container } = render(
      <QuestionPromptCard
        requestId={REQUEST_ID}
        entries={[]}
        isSubmitting={false}
        onSubmitAll={() => {}}
      />,
    );

    // No options or input — the card body short-circuits with no content.
    expect(container.querySelector("input")).toBeNull();
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("selects an option when the matching numeric hotkey is pressed", async () => {
    const user = userEvent.setup();
    const onSubmitAll = mock((_responses: QuestionResponseEntry[]) => {});
    render(
      <QuestionPromptCard
        requestId={REQUEST_ID}
        entries={[makeEntry()]}
        isSubmitting={false}
        onSubmitAll={onSubmitAll}
      />,
    );

    expect(document.activeElement).not.toBeInstanceOf(HTMLInputElement);
    await user.keyboard("1");
    expect(onSubmitAll).toHaveBeenCalledTimes(1);
    expect(onSubmitAll).toHaveBeenCalledWith([
      { questionId: "q1", kind: "option", optionId: "yes" },
    ]);
  });

  it("focuses the inline input when the N+1 hotkey is pressed", async () => {
    const user = userEvent.setup();
    const onSubmitAll = mock(() => {});
    render(
      <QuestionPromptCard
        requestId={REQUEST_ID}
        entries={[makeEntry()]}
        isSubmitting={false}
        onSubmitAll={onSubmitAll}
      />,
    );

    const input = screen.getByRole("textbox", {
      name: /type a different answer/i,
    });
    expect(document.activeElement).not.toBe(input);

    await user.keyboard("3");

    expect(document.activeElement).toBe(input);
    expect(onSubmitAll).not.toHaveBeenCalled();
  });

  it("does not intercept digits typed into the free-text input", async () => {
    const user = userEvent.setup();
    const onSubmitAll = mock(() => {});
    render(
      <QuestionPromptCard
        requestId={REQUEST_ID}
        entries={[makeEntry()]}
        isSubmitting={false}
        onSubmitAll={onSubmitAll}
      />,
    );

    const input = screen.getByRole("textbox", {
      name: /type a different answer/i,
    }) as HTMLInputElement;
    input.focus();

    await user.type(input, "12345");
    expect(input.value).toBe("12345");
    expect(onSubmitAll).not.toHaveBeenCalled();
  });

  it("`s` hotkey auto-submits a skip on single-entry batches", async () => {
    const user = userEvent.setup();
    const onSubmitAll = mock((_responses: QuestionResponseEntry[]) => {});
    render(
      <QuestionPromptCard
        requestId={REQUEST_ID}
        entries={[makeEntry()]}
        isSubmitting={false}
        onSubmitAll={onSubmitAll}
      />,
    );

    await user.keyboard("s");
    expect(onSubmitAll).toHaveBeenCalledTimes(1);
    expect(onSubmitAll).toHaveBeenCalledWith([{ questionId: "q1", kind: "skip" }]);
  });
});

describe("QuestionPromptCard — close (X) button", () => {
  afterEach(cleanup);

  it("does not render the close button when onClose is omitted", () => {
    render(
      <QuestionPromptCard
        requestId={REQUEST_ID}
        entries={[makeEntry()]}
        isSubmitting={false}
        onSubmitAll={() => {}}
      />,
    );

    expect(screen.queryByRole("button", { name: /close question/i })).toBeNull();
  });

  it("fires onClose on click without invoking onSubmitAll", async () => {
    const user = userEvent.setup();
    const onSubmitAll = mock(() => {});
    const onClose = mock(() => {});

    render(
      <QuestionPromptCard
        requestId={REQUEST_ID}
        entries={[makeEntry()]}
        isSubmitting={false}
        onSubmitAll={onSubmitAll}
        onClose={onClose}
      />,
    );

    // Type some text first to verify Close skips submit even with a draft in
    // progress. Discarding draft state is the owner's responsibility (by
    // dropping `pendingQuestion`, which unmounts the card entirely).
    await user.type(
      screen.getByRole("textbox", { name: /type a different answer/i }),
      "halfway",
    );

    await user.click(screen.getByRole("button", { name: /close question/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSubmitAll).not.toHaveBeenCalled();
  });

  it("Escape closes the card when no text is typed and onClose is supplied", async () => {
    const user = userEvent.setup();
    const onClose = mock(() => {});
    render(
      <QuestionPromptCard
        requestId={REQUEST_ID}
        entries={[makeEntry()]}
        isSubmitting={false}
        onSubmitAll={() => {}}
        onClose={onClose}
      />,
    );

    // No element focused: the keystroke routes through the window-level
    // `useOptionHotkeys` Escape handler.
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape on a focused-but-empty free-text input still closes the card", async () => {
    const user = userEvent.setup();
    const onClose = mock(() => {});
    render(
      <QuestionPromptCard
        requestId={REQUEST_ID}
        entries={[makeEntry()]}
        isSubmitting={false}
        onSubmitAll={() => {}}
        onClose={onClose}
      />,
    );

    const input = screen.getByRole("textbox", {
      name: /type a different answer/i,
    }) as HTMLInputElement;
    input.focus();
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("");

    // The global useOptionHotkeys Escape handler bails out when an input is
    // focused, so the card's own keydown handler is responsible for calling
    // onClose here.
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape with typed text clears the input WITHOUT firing onClose", async () => {
    const user = userEvent.setup();
    const onClose = mock(() => {});
    render(
      <QuestionPromptCard
        requestId={REQUEST_ID}
        entries={[makeEntry()]}
        isSubmitting={false}
        onSubmitAll={() => {}}
        onClose={onClose}
      />,
    );

    const input = screen.getByRole("textbox", {
      name: /type a different answer/i,
    }) as HTMLInputElement;
    await user.type(input, "hello");
    expect(input.value).toBe("hello");

    await user.keyboard("{Escape}");

    // Input should be cleared (intended), but the global Escape hotkey must
    // NOT fire — the input keydown handler stops propagation so the window
    // listener doesn't see the blurred-input state and close the card.
    expect(input.value).toBe("");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("disables the close button while a response is submitting", () => {
    render(
      <QuestionPromptCard
        requestId={REQUEST_ID}
        entries={[makeEntry()]}
        isSubmitting={true}
        onSubmitAll={() => {}}
        onClose={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: /close question/i })).toBeDisabled();
  });
});

describe("QuestionPromptCard — paginated batch", () => {
  afterEach(cleanup);

  it("renders the pagination cluster and chevrons; left chevron is disabled at index 0", () => {
    render(
      <QuestionPromptCard
        requestId={REQUEST_ID}
        entries={threeEntries()}
        isSubmitting={false}
        onSubmitAll={() => {}}
      />,
    );

    expect(screen.getByText(/1 of 3/i)).toBeInTheDocument();
    expect(screen.getByText("First?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /previous question/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /next question/i })).not.toBeDisabled();
  });

  it("advances on `>` click; records draft on option click without posting", async () => {
    const user = userEvent.setup();
    const onSubmitAll = mock(() => {});
    render(
      <QuestionPromptCard
        requestId={REQUEST_ID}
        entries={threeEntries()}
        isSubmitting={false}
        onSubmitAll={onSubmitAll}
      />,
    );

    await user.click(screen.getByRole("button", { name: /next question/i }));
    expect(screen.getByText("Second?")).toBeInTheDocument();
    expect(screen.getByText(/2 of 3/i)).toBeInTheDocument();
    expect(onSubmitAll).not.toHaveBeenCalled();
  });

  it("selecting an option auto-advances to the next unresolved entry", async () => {
    const user = userEvent.setup();
    const onSubmitAll = mock(() => {});
    render(
      <QuestionPromptCard
        requestId={REQUEST_ID}
        entries={threeEntries()}
        isSubmitting={false}
        onSubmitAll={onSubmitAll}
      />,
    );

    // Entry 1's options come from makeEntry() — "yes" / "no"
    await user.click(
      screen.getByRole("button", { name: /Option 1: Yes, proceed/ }),
    );
    expect(screen.getByText("Second?")).toBeInTheDocument();
    expect(screen.getByText(/2 of 3/i)).toBeInTheDocument();
    expect(onSubmitAll).not.toHaveBeenCalled();
  });

  it("Enter on free-text records draft, advances, and does not POST yet", async () => {
    const user = userEvent.setup();
    const onSubmitAll = mock(() => {});
    render(
      <QuestionPromptCard
        requestId={REQUEST_ID}
        entries={threeEntries()}
        isSubmitting={false}
        onSubmitAll={onSubmitAll}
      />,
    );

    const input = screen.getByRole("textbox", {
      name: /type a different answer/i,
    });
    await user.type(input, "Something custom{Enter}");
    expect(screen.getByText("Second?")).toBeInTheDocument();
    expect(onSubmitAll).not.toHaveBeenCalled();
  });

  it("Skip records draft, advances, no POST", async () => {
    const user = userEvent.setup();
    const onSubmitAll = mock(() => {});
    render(
      <QuestionPromptCard
        requestId={REQUEST_ID}
        entries={threeEntries()}
        isSubmitting={false}
        onSubmitAll={onSubmitAll}
      />,
    );

    await user.click(screen.getByRole("button", { name: /skip this question/i }));
    expect(screen.getByText("Second?")).toBeInTheDocument();
    expect(onSubmitAll).not.toHaveBeenCalled();
  });

  it("after every entry drafted: auto-submits the batch in original entries[] order", async () => {
    const user = userEvent.setup();
    const onSubmitAll = mock((_responses: QuestionResponseEntry[]) => {});
    render(
      <QuestionPromptCard
        requestId={REQUEST_ID}
        entries={threeEntries()}
        isSubmitting={false}
        onSubmitAll={onSubmitAll}
      />,
    );

    // Entry 1: pick option "yes"
    await user.click(
      screen.getByRole("button", { name: /Option 1: Yes, proceed/ }),
    );
    expect(onSubmitAll).not.toHaveBeenCalled();
    // Entry 2: pick option "Alpha"
    await user.click(
      screen.getByRole("button", { name: /Option 1: Alpha/ }),
    );
    expect(onSubmitAll).not.toHaveBeenCalled();
    // Entry 3: free-text via Enter — final entry, auto-submits the batch
    const input = screen.getByRole("textbox", {
      name: /type a different answer/i,
    });
    await user.type(input, "third{Enter}");

    expect(onSubmitAll).toHaveBeenCalledTimes(1);
    expect(onSubmitAll).toHaveBeenCalledWith([
      { questionId: "q1", kind: "option", optionId: "yes" },
      { questionId: "q2", kind: "option", optionId: "a" },
      { questionId: "q3", kind: "free_text", text: "third" },
    ]);
  });

  it("revising via `<` before the last answer overwrites the prior draft", async () => {
    const user = userEvent.setup();
    const onSubmitAll = mock((_responses: QuestionResponseEntry[]) => {});
    render(
      <QuestionPromptCard
        requestId={REQUEST_ID}
        entries={threeEntries()}
        isSubmitting={false}
        onSubmitAll={onSubmitAll}
      />,
    );

    // Entry 1: pick "yes" — auto-advance to entry 2.
    await user.click(
      screen.getByRole("button", { name: /Option 1: Yes, proceed/ }),
    );
    expect(onSubmitAll).not.toHaveBeenCalled();

    // Navigate back to entry 1 and change to "no" — auto-advance jumps to
    // the first unresolved entry (entry 2).
    await user.click(screen.getByRole("button", { name: /previous question/i }));
    expect(screen.getByText("First?")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /Option 2: No, cancel/ }),
    );
    expect(onSubmitAll).not.toHaveBeenCalled();

    // Finish entries 2 and 3; the last answer auto-submits with the revised
    // entry-1 selection.
    await user.click(
      screen.getByRole("button", { name: /Option 1: Alpha/ }),
    );
    await user.click(screen.getByRole("button", { name: /skip this question/i }));

    expect(onSubmitAll).toHaveBeenCalledTimes(1);
    expect(onSubmitAll).toHaveBeenCalledWith([
      { questionId: "q1", kind: "option", optionId: "no" },
      { questionId: "q2", kind: "option", optionId: "a" },
      { questionId: "q3", kind: "skip" },
    ]);
  });

  it("right chevron is disabled at the final entry", async () => {
    const user = userEvent.setup();
    render(
      <QuestionPromptCard
        requestId={REQUEST_ID}
        entries={threeEntries()}
        isSubmitting={false}
        onSubmitAll={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: /next question/i }));
    await user.click(screen.getByRole("button", { name: /next question/i }));
    expect(screen.getByText(/3 of 3/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /next question/i })).toBeDisabled();
  });

  it("`←` / `→` arrow keys paginate when the input is not focused", async () => {
    const user = userEvent.setup();
    render(
      <QuestionPromptCard
        requestId={REQUEST_ID}
        entries={threeEntries()}
        isSubmitting={false}
        onSubmitAll={() => {}}
      />,
    );

    await user.keyboard("{ArrowRight}");
    expect(screen.getByText("Second?")).toBeInTheDocument();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByText("First?")).toBeInTheDocument();
  });

  it("does not paginate via arrow keys when the free-text input is focused", async () => {
    const user = userEvent.setup();
    render(
      <QuestionPromptCard
        requestId={REQUEST_ID}
        entries={threeEntries()}
        isSubmitting={false}
        onSubmitAll={() => {}}
      />,
    );

    const input = screen.getByRole("textbox", {
      name: /type a different answer/i,
    });
    input.focus();
    await user.keyboard("{ArrowRight}");
    // Still on the first question — the input owned the keystroke.
    expect(screen.getByText("First?")).toBeInTheDocument();
  });

  it("shows a check icon on the previously-selected option when revisiting", async () => {
    const user = userEvent.setup();
    render(
      <QuestionPromptCard
        requestId={REQUEST_ID}
        entries={threeEntries()}
        isSubmitting={false}
        onSubmitAll={() => {}}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /Option 1: Yes, proceed/ }),
    );
    // We're now on entry 2. Navigate back.
    await user.click(screen.getByRole("button", { name: /previous question/i }));
    // The selected option's row should contain a lucide check icon. Lucide
    // renders SVGs with class names; we check the row contains an svg.
    const selectedRow = screen.getByRole("button", {
      name: /Option 1: Yes, proceed/,
    });
    expect(selectedRow.querySelector("svg")).not.toBeNull();
  });

  it("free-text draft persists across pagination", async () => {
    const user = userEvent.setup();
    render(
      <QuestionPromptCard
        requestId={REQUEST_ID}
        entries={threeEntries()}
        isSubmitting={false}
        onSubmitAll={() => {}}
      />,
    );

    const input = screen.getByRole("textbox", {
      name: /type a different answer/i,
    }) as HTMLInputElement;
    await user.type(input, "in progress");
    expect(input.value).toBe("in progress");

    // Move forward, then back.
    await user.click(screen.getByRole("button", { name: /next question/i }));
    await user.click(screen.getByRole("button", { name: /previous question/i }));

    const input2 = screen.getByRole("textbox", {
      name: /type a different answer/i,
    }) as HTMLInputElement;
    expect(input2.value).toBe("in progress");
  });

  it("`s` hotkey skips the current entry on a batched card", async () => {
    const user = userEvent.setup();
    const onSubmitAll = mock(() => {});
    render(
      <QuestionPromptCard
        requestId={REQUEST_ID}
        entries={threeEntries()}
        isSubmitting={false}
        onSubmitAll={onSubmitAll}
      />,
    );

    expect(screen.getByText("First?")).toBeInTheDocument();
    await user.keyboard("s");
    // Skip records a draft and advances to the next unresolved entry. No
    // POST yet — batched UX waits for Done.
    expect(screen.getByText("Second?")).toBeInTheDocument();
    expect(onSubmitAll).not.toHaveBeenCalled();
  });

});

describe("QuestionPromptCard — coarse pointer (touch)", () => {
  // Stub `window.matchMedia` so `isPointerCoarse()` returns true. The
  // numeric badges on option rows hint at a hardware-keyboard affordance,
  // so they must be hidden on touch devices. The pencil icon on the
  // free-text row stays — it's iconography, not a hotkey hint.
  let originalMatchMedia: typeof window.matchMedia | undefined;

  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === "(pointer: coarse)",
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  });

  afterEach(() => {
    if (originalMatchMedia) {
      window.matchMedia = originalMatchMedia;
    }
    cleanup();
  });

  it("hides numeric badges, keeps chevrons/pencil/Done functional", async () => {
    const user = userEvent.setup();
    render(
      <QuestionPromptCard
        requestId={REQUEST_ID}
        entries={threeEntries()}
        isSubmitting={false}
        onSubmitAll={() => {}}
      />,
    );

    // Numeric badges are decorative — the option labels still render but
    // the badge spans with the literal "1"/"2"/"3" markers must not be in
    // the DOM. Use the description on the Option 2 button to scope the
    // search away from the pagination cluster ("1 of 3").
    expect(screen.queryByText("1", { selector: "span" })).toBeNull();
    expect(screen.queryByText("2", { selector: "span" })).toBeNull();
    expect(screen.queryByText("3", { selector: "span" })).toBeNull();

    // Chevrons still render and are interactive.
    const next = screen.getByRole("button", { name: /next question/i });
    const prev = screen.getByRole("button", { name: /previous question/i });
    expect(next).not.toBeDisabled();
    expect(prev).toBeDisabled();
    await user.click(next);
    expect(screen.getByText("Second?")).toBeInTheDocument();

    // The pencil icon row is still present (the input is the free-text row).
    expect(
      screen.getByRole("textbox", { name: /type a different answer/i }),
    ).toBeInTheDocument();
  });
});
