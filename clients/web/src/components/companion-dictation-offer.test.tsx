import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { CompanionDictationOffer } from "@/components/companion-dictation-offer";

const OFFER = { app: "Wispr Flow", text: "Send me the files." };

const buttonOf = (container: HTMLElement, name: string) =>
  Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === name,
  ) ?? null;

afterEach(() => {
  cleanup();
});

describe("the card offering Vellum's dictation", () => {
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
