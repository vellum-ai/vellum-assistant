/**
 * Tests for the established-assistant guard step: name-aware copy and the
 * keep / redo choice wiring.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";

import { ExistingAssistantStep } from "@/domains/onboarding/screens/existing-assistant-step";

function renderStep(
  props: Partial<Parameters<typeof ExistingAssistantStep>[0]> = {},
) {
  return render(
    <ExistingAssistantStep
      assistantName="Viper"
      onKeep={() => {}}
      onRedo={() => {}}
      onBack={() => {}}
      {...props}
    />,
  );
}

afterEach(cleanup);

describe("ExistingAssistantStep", () => {
  test("names the assistant it is protecting", () => {
    renderStep();

    expect(
      screen.getByText("Viper is already up and running"),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Keep Viper and start chatting/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: /Start over and rebuild Viper's personality/,
      }),
    ).toBeTruthy();
  });

  test("falls back to generic copy when the name is unknown", () => {
    renderStep({ assistantName: null });

    expect(
      screen.getByText("Your assistant is already up and running"),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: /Keep your assistant and start chatting/,
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: /Start over and rebuild its personality/,
      }),
    ).toBeTruthy();
  });

  test("keep and redo fire their callbacks", () => {
    const onKeep = mock(() => {});
    const onRedo = mock(() => {});
    renderStep({ onKeep, onRedo });

    fireEvent.click(
      screen.getByRole("button", { name: /Keep Viper and start chatting/ }),
    );
    expect(onKeep).toHaveBeenCalledTimes(1);
    expect(onRedo).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", {
        name: /Start over and rebuild Viper's personality/,
      }),
    );
    expect(onRedo).toHaveBeenCalledTimes(1);
  });
});
