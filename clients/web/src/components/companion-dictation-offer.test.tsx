import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { CompanionDictationOffer } from "@/components/companion-dictation-offer";

const OFFER = {
  reason: "claimed",
  id: "offer-1",
  app: "Wispr Flow",
  text: "Send me the files.",
} as const;

const UNPLACED = {
  reason: "no-text-field",
  id: "offer-2",
  text: "onions, tomatoes, and a bag of rice",
} as const;

const buttonOf = (container: HTMLElement, name: string) =>
  Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === name,
  ) ?? null;

afterEach(() => {
  cleanup();
});

describe("the card offering Vellum's version of another app's paste", () => {
  test("shows the words whole with every answer spelled out", () => {
    const { container } = render(<CompanionDictationOffer offer={OFFER} />);
    expect(container.textContent).toContain("Vellum heard");
    expect(container.textContent).toContain("Send me the files.");
    expect(buttonOf(container, "Use Vellum's")).not.toBeNull();
    expect(buttonOf(container, "Quit Wispr Flow")).not.toBeNull();
    expect(buttonOf(container, "Not now")).not.toBeNull();
  });

  test("each answer travels as itself", () => {
    const answers: string[] = [];
    const { container } = render(
      <CompanionDictationOffer
        offer={OFFER}
        onAnswer={(answer) => {
          answers.push(answer);
        }}
      />,
    );
    fireEvent.click(buttonOf(container, "Use Vellum's")!);
    fireEvent.click(buttonOf(container, "Quit Wispr Flow")!);
    fireEvent.click(buttonOf(container, "Not now")!);
    expect(answers).toEqual(["use", "quit", "dismiss"]);
  });
});

/**
 * The same card for the other thing that ends a hold with its words in hand.
 * Nothing in front takes text, so there is no app to quit and nowhere to put
 * the words: the clipboard is the only answer left, and it is the one the
 * card leads with.
 */
describe("the card offering a dictation nothing would take", () => {
  test("offers the clipboard and nothing that needs an application", () => {
    const { container } = render(<CompanionDictationOffer offer={UNPLACED} />);
    expect(container.textContent).toContain("Nowhere to put these");
    expect(container.textContent).toContain(
      "onions, tomatoes, and a bag of rice",
    );
    expect(buttonOf(container, "Copy")).not.toBeNull();
    expect(buttonOf(container, "Discard")).not.toBeNull();
    expect(buttonOf(container, "Use Vellum's")).toBeNull();
    expect(container.textContent).not.toContain("Quit");
  });

  test("its two answers travel as themselves", () => {
    const answers: string[] = [];
    const { container } = render(
      <CompanionDictationOffer
        offer={UNPLACED}
        onAnswer={(answer) => {
          answers.push(answer);
        }}
      />,
    );
    fireEvent.click(buttonOf(container, "Copy")!);
    fireEvent.click(buttonOf(container, "Discard")!);
    expect(answers).toEqual(["copy", "dismiss"]);
  });
});
