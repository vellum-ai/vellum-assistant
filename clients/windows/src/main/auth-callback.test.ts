import { describe, expect, test } from "bun:test";

import { startWindowsAuthCallback } from "./auth-callback";

function callbackHarness() {
  let listener: (url: string) => void = () => {};
  let unsubscribeCalls = 0;
  return {
    emit: (url: string) => listener(url),
    get unsubscribeCalls() {
      return unsubscribeCalls;
    },
    subscribe: (next: (url: string) => void) => {
      listener = next;
      return () => {
        unsubscribeCalls += 1;
      };
    },
  };
}

describe("startWindowsAuthCallback", () => {
  test("accepts a state-matched code on the registered app scheme", async () => {
    const harness = callbackHarness();
    const callback = await startWindowsAuthCallback("expected", {
      scheme: "vellum-assistant-dev",
      subscribe: harness.subscribe,
    });

    expect(callback.redirectUri).toBe("vellum-assistant-dev://auth/callback");

    harness.emit(
      "vellum-assistant-dev://auth/callback?code=wrong&state=unexpected",
    );
    harness.emit("https://example.com/callback?code=wrong&state=expected");
    harness.emit(
      "vellum-assistant-dev://auth/callback?code=good&state=expected",
    );

    expect(await callback.waitForCode).toBe("good");
    expect(harness.unsubscribeCalls).toBe(1);
  });

  test("surfaces a state-matched provider error", async () => {
    const harness = callbackHarness();
    const callback = await startWindowsAuthCallback("expected", {
      scheme: "vellum-assistant-dev",
      subscribe: harness.subscribe,
    });
    const result = callback.waitForCode.catch((error: Error) => error);

    harness.emit(
      "vellum-assistant-dev://auth/callback?error=access_denied&error_description=Denied&state=expected",
    );

    await expect(result).resolves.toMatchObject({
      message: "Authentication failed: access_denied: Denied",
    });
    expect(harness.unsubscribeCalls).toBe(1);
  });

  test("close cancels the pending callback and unsubscribes", async () => {
    const harness = callbackHarness();
    const callback = await startWindowsAuthCallback("expected", {
      scheme: "vellum-assistant-dev",
      subscribe: harness.subscribe,
    });
    const result = callback.waitForCode.catch((error: Error) => error);

    callback.close("Sign-in timed out.");

    await expect(result).resolves.toMatchObject({
      message: "Sign-in timed out.",
    });
    expect(harness.unsubscribeCalls).toBe(1);
  });
});
