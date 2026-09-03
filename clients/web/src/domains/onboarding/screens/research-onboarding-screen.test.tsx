/**
 * The "Let's start with you" form gates Continue on the first name alone.
 * Role and hobbies sharpen the research when present, but a user who leaves
 * them blank must still be able to move on: every downstream consumer of
 * `occupation` already tolerates an empty string.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";

// Decorative and self-measuring; the form gate is what is under test.
mock.module(
  "@/domains/onboarding/components/onboarding-edge-characters",
  () => ({
    OnboardingEdgeCharacters: () => null,
  }),
);

const { ResearchOnboardingScreen } =
  await import("@/domains/onboarding/screens/research-onboarding-screen");
type ResearchOnboardingValues =
  import("@/domains/onboarding/screens/research-onboarding-screen").ResearchOnboardingValues;

function continueButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /continue/i });
}

afterEach(() => {
  cleanup();
});

describe("ResearchOnboardingScreen", () => {
  test("Continue is disabled until a first name is entered", () => {
    render(<ResearchOnboardingScreen onSubmit={() => {}} />);
    expect(continueButton().disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText("Your name"), {
      target: { value: "Ada" },
    });
    expect(continueButton().disabled).toBe(false);
  });

  test("submits with only a first name; role is optional", () => {
    const onSubmit = mock((_values: ResearchOnboardingValues) => {});
    render(<ResearchOnboardingScreen onSubmit={onSubmit} />);

    fireEvent.change(screen.getByPlaceholderText("Your name"), {
      target: { value: "Ada" },
    });
    fireEvent.click(continueButton());

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({
      firstName: "Ada",
      lastName: "",
      role: "",
      hobbies: [],
    });
  });

  test("the role field is not marked required", () => {
    render(<ResearchOnboardingScreen onSubmit={() => {}} />);
    const role = screen.getByPlaceholderText(
      "What do you do for work?",
    ) as HTMLInputElement;
    expect(role.required).toBe(false);
  });
});
