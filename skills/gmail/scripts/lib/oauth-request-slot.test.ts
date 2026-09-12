import { afterEach, describe, expect, test } from "bun:test";

import {
  MAX_CONCURRENT_OAUTH_REQUESTS,
  resetOauthRequestSlotForTests,
  withOauthRequestSlot,
} from "./oauth-request-slot.ts";

afterEach(() => {
  resetOauthRequestSlotForTests();
});

describe("withOauthRequestSlot", () => {
  test("never admits more than MAX_CONCURRENT_OAUTH_REQUESTS holders", async () => {
    let current = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 20 }, async () => {
        await withOauthRequestSlot(async () => {
          current += 1;
          peak = Math.max(peak, current);
          await Bun.sleep(15);
          current -= 1;
        });
      }),
    );

    expect(MAX_CONCURRENT_OAUTH_REQUESTS).toBe(4);
    expect(peak).toBe(4);
    expect(current).toBe(0);
  });

  test("releases the slot when the work throws", async () => {
    await expect(
      withOauthRequestSlot(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    let entered = false;
    await withOauthRequestSlot(async () => {
      entered = true;
    });
    expect(entered).toBe(true);
  });
});
