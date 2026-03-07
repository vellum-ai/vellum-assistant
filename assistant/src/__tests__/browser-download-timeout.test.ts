import { describe, expect, it } from "bun:test";

import { withTimeout } from "../tools/browser/browser-manager.js";

describe("withTimeout", () => {
  it("resolves normally for a fast promise", async () => {
    const result = await withTimeout(Promise.resolve("ok"), 1_000, "fast");
    expect(result).toBe("ok");
  });

  it("rejects with timeout error for a hanging promise", async () => {
    const hanging = new Promise<string>(() => {
      // never resolves
    });

    await expect(withTimeout(hanging, 50, "slow op")).rejects.toThrow(
      "slow op timed out after 50ms",
    );
  });

  it("propagates the original rejection if it happens before the timeout", async () => {
    const failing = Promise.reject(new Error("original error"));

    await expect(withTimeout(failing, 1_000, "failing")).rejects.toThrow(
      "original error",
    );
  });
});
