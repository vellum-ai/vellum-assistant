import { describe, expect, test } from "bun:test";

import { startLoopbackListener } from "../commands/login.js";

/** Resolve "settled"/"pending" — proves whether `waitForCode` resolved. */
async function settleState(p: Promise<unknown>): Promise<"settled" | "pending"> {
  return Promise.race([
    p.then(
      () => "settled" as const,
      () => "settled" as const,
    ),
    new Promise<"pending">((r) => setTimeout(() => r("pending"), 50)),
  ]);
}

describe("startLoopbackListener", () => {
  test("rejects a state-mismatched callback (CSRF) without settling", async () => {
    const listener = await startLoopbackListener("expected-state");
    try {
      // Wrong state — the load-bearing CSRF check. Any local process can
      // hit the loopback port, so a mismatched state must NOT deliver a code.
      const res = await fetch(`${listener.redirectUri}?code=evil&state=wrong`);
      expect(res.status).toBe(404);
      expect(await settleState(listener.waitForCode)).toBe("pending");

      // Wrong path on the right port is also ignored.
      const noise = await fetch(
        `${listener.redirectUri.replace("/auth/callback", "/evil")}?state=expected-state&code=c`,
      );
      expect(noise.status).toBe(404);
      expect(await settleState(listener.waitForCode)).toBe("pending");

      // A state-matched callback then settles it — the listener kept
      // listening through the noise above.
      const ok = await fetch(
        `${listener.redirectUri}?code=good-code&state=expected-state`,
      );
      expect(ok.status).toBe(200);
      expect(await listener.waitForCode).toBe("good-code");
    } finally {
      listener.close();
    }
  });

  test("rejects on an error callback with the matching state", async () => {
    const listener = await startLoopbackListener("st");
    try {
      const settled = listener.waitForCode.then(
        () => null,
        (e: Error) => e,
      );
      const res = await fetch(`${listener.redirectUri}?error=access_denied&state=st`);
      expect(res.status).toBe(400);
      const err = await settled;
      expect(err?.message).toMatch(/access_denied/);
    } finally {
      listener.close();
    }
  });

  test("close rejects a pending waiter with the given reason", async () => {
    const listener = await startLoopbackListener("st");
    const settled = listener.waitForCode.then(
      () => null,
      (e: Error) => e,
    );
    listener.close("Login timed out. Please try again.");
    const err = await settled;
    expect(err?.message).toMatch(/timed out/);
  });
});
