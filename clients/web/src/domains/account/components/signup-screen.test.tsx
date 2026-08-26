/**
 * The sign-up screen's handoff to AuthKit: one flow at a time, and a failure
 * that hands the screen back. The handoff is not instant, so a second
 * activation would otherwise replace the flow already running, which the
 * native plugin rejects as a failure the user never caused.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import * as nativeAuth from "@/runtime/native-auth";

/** Rejecters for the flows started so far, so each one stays pending. */
const startedFlows: ((err: unknown) => void)[] = [];

mock.module("@/runtime/native-auth", (): typeof nativeAuth => ({
  ...nativeAuth,
  startAuthFlow: () =>
    new Promise<void>((_resolve, reject) => {
      startedFlows.push(reject);
    }),
}));

const { SignupScreen } = await import(
  "@/domains/account/components/signup-screen"
);

const GENERIC_FAILURE = "Something went wrong. Please try again.";

const continueButton = () => screen.getByText("Continue").closest("button");
const signInButton = () => screen.getByText("Sign in").closest("button");

describe("SignupScreen auth handoff", () => {
  beforeEach(() => {
    startedFlows.length = 0;
    render(<SignupScreen returnTo={null} />);
  });

  afterEach(cleanup);

  test("a second press cannot open a second flow", () => {
    fireEvent.click(screen.getByText("Continue"));
    fireEvent.click(screen.getByText("Continue"));

    expect(startedFlows).toHaveLength(1);
    expect(continueButton()?.disabled).toBe(true);
  });

  test("a pending signup blocks the sign-in link too", () => {
    fireEvent.click(screen.getByText("Continue"));
    fireEvent.click(screen.getByText("Sign in"));

    expect(startedFlows).toHaveLength(1);
    expect(signInButton()?.disabled).toBe(true);
  });

  test("the sign-in link holds the screen the same way", () => {
    fireEvent.click(screen.getByText("Sign in"));
    fireEvent.click(screen.getByText("Sign in"));
    fireEvent.click(screen.getByText("Continue"));

    expect(startedFlows).toHaveLength(1);
    expect(continueButton()?.disabled).toBe(true);
  });

  test("a failed handoff hands the screen back", async () => {
    fireEvent.click(screen.getByText("Continue"));
    startedFlows[0]?.(new Error("handoff refused"));

    await waitFor(() => {
      expect(screen.getByText(GENERIC_FAILURE)).toBeTruthy();
    });
    expect(continueButton()?.disabled).toBe(false);

    fireEvent.click(screen.getByText("Continue"));

    expect(startedFlows).toHaveLength(2);
    expect(screen.queryByText(GENERIC_FAILURE)).toBeNull();
  });
});
