import { describe, test } from "bun:test";

// These tests require bun:test + @testing-library/jest-dom integration
// (toBeInTheDocument, toHaveAttribute, toBeDisabled matchers) and
// @testing-library/user-event v14 setup() API.
// Convert from test.todo to test once the test infrastructure is set up.

describe("QuestionPromptCard — single entry", () => {
  test.todo("renders the question text, option buttons, and the free-text input", () => {});
  test.todo("hides the pagination counter for a single entry but still renders disabled chevrons + X", () => {});
  test.todo("auto-submits a one-element batch when an option is tapped", () => {});
  test.todo("auto-submits on Enter inside the free-text input", () => {});
  test.todo("auto-submits a skip via the Skip button when no text is typed", () => {});
  test.todo("falls back to a generic placeholder when freeTextPlaceholder is omitted", () => {});
  test.todo("swaps Skip for Send the moment the input has text and submits via Send", () => {});
  test.todo("disables option buttons while the free-text input has text", () => {});
  test.todo("does not submit on Enter when the input is whitespace-only", () => {});
  test.todo("clears the inline input on Escape when there is text", () => {});
  test.todo("disables option buttons, send button, and the input when isSubmitting is true", () => {});
  test.todo("renders defensively and warns when zero entries are supplied", () => {});
  test.todo("selects an option when the matching numeric hotkey is pressed", () => {});
  test.todo("focuses the inline input when the N+1 hotkey is pressed", () => {});
  test.todo("does not intercept digits typed into the free-text input", () => {});
  test.todo("`s` hotkey auto-submits a skip on single-entry batches", () => {});
});

describe("QuestionPromptCard — close (X) button", () => {
  test.todo("does not render the close button when onClose is omitted", () => {});
  test.todo("fires onClose on click without invoking onSubmitAll", () => {});
  test.todo("Escape closes the card when no text is typed and onClose is supplied", () => {});
  test.todo("Escape on a focused-but-empty free-text input still closes the card", () => {});
  test.todo("Escape with typed text clears the input WITHOUT firing onClose", () => {});
  test.todo("disables the close button while a response is submitting", () => {});
});

describe("QuestionPromptCard — paginated batch", () => {
  test.todo("renders the pagination cluster and chevrons; left chevron is disabled at index 0", () => {});
  test.todo("advances on `>` click; records draft on option click without posting", () => {});
  test.todo("selecting an option auto-advances to the next unresolved entry", () => {});
  test.todo("Enter on free-text records draft, advances, and does not POST yet", () => {});
  test.todo("Skip records draft, advances, no POST", () => {});
  test.todo("after every entry drafted: auto-submits the batch in original entries[] order", () => {});
  test.todo("revising via `<` before the last answer overwrites the prior draft", () => {});
  test.todo("right chevron is disabled at the final entry", () => {});
  test.todo("`←` / `→` arrow keys paginate when the input is not focused", () => {});
  test.todo("does not paginate via arrow keys when the free-text input is focused", () => {});
  test.todo("shows a check icon on the previously-selected option when revisiting", () => {});
  test.todo("free-text draft persists across pagination", () => {});
  test.todo("`s` hotkey skips the current entry on a batched card", () => {});
});

describe("QuestionPromptCard — coarse pointer (touch)", () => {
  test.todo("hides numeric badges, keeps chevrons/pencil/Done functional", () => {});
});
