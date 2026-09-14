import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { gmailRequest } from "./gmail-client.ts";
import { resetOauthRequestSlotForTests } from "./oauth-request-slot.ts";

afterEach(() => {
  resetOauthRequestSlotForTests();
});

function mockOauthProcess(onStart: () => void, onExit: () => void) {
  const payload = JSON.stringify({
    ok: true,
    status: 200,
    headers: {},
    body: { id: "msg-1" },
  });
  const stdout = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  });
  const stderr = new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
  onStart();
  return {
    stdout,
    stderr,
    exited: (async () => {
      await Bun.sleep(20);
      onExit();
      return 0;
    })(),
  } as ReturnType<typeof Bun.spawn>;
}

describe("gmailRequest oauth spawn cap", () => {
  test("runs at most 4 assistant oauth request processes at a time", async () => {
    let current = 0;
    let peak = 0;
    const spawn = spyOn(Bun, "spawn").mockImplementation((() =>
      mockOauthProcess(
        () => {
          current += 1;
          peak = Math.max(peak, current);
        },
        () => {
          current -= 1;
        },
      )) as typeof Bun.spawn);

    try {
      await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          gmailRequest({ method: "GET", path: `/messages/${i}` }),
        ),
      );
      expect(peak).toBe(4);
      expect(current).toBe(0);
      expect(spawn.mock.calls.length).toBe(12);
    } finally {
      spawn.mockRestore();
    }
  });
});
