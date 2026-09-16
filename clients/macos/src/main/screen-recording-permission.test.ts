import { beforeEach, describe, expect, mock, test } from "bun:test";

import { JsonRpcHelperError } from "./sidecar/mac-helper.client";

let helperStatus = "denied";
let helperReads = 0;
let helperShutdowns = 0;

mock.module("./hotkey-helper", () => ({
  queryFreshMacHelperPermission: async (kind: string) => {
    expect(kind).toBe("screen");
    helperReads += 1;
    return helperStatus;
  },
}));

mock.module("./sidecar/shared-cu-helper", () => ({
  shutdownSharedCuHelper: () => {
    helperShutdowns += 1;
  },
}));

mock.module("./logger", () => ({
  default: { info: () => undefined, warn: () => undefined },
}));

const {
  __resetScreenRecordingPermissionForTesting,
  answerScreenRecordingRefusal,
  isScreenRecordingRefusal,
  JSON_RPC_PERMISSION_DENIED,
  readScreenRecordingPermission,
  screenRecordingGranted,
} = await import("./screen-recording-permission");

beforeEach(() => {
  __resetScreenRecordingPermissionForTesting();
  helperStatus = "denied";
  helperReads = 0;
  helperShutdowns = 0;
});

describe("isScreenRecordingRefusal", () => {
  test("is the helper's permission code and nothing else", () => {
    expect(
      isScreenRecordingRefusal(
        new JsonRpcHelperError({
          code: JSON_RPC_PERMISSION_DENIED,
          message: "Screen Recording permission denied",
        }),
      ),
    ).toBe(true);
    expect(
      isScreenRecordingRefusal(
        new JsonRpcHelperError({
          code: -32603,
          message: "The window to capture is no longer on screen",
        }),
      ),
    ).toBe(false);
    expect(
      isScreenRecordingRefusal(new Error("Screen Recording permission denied")),
    ).toBe(false);
  });
});

describe("readScreenRecordingPermission", () => {
  test("lets the capturing helper go when the grant is newly given", async () => {
    expect(await readScreenRecordingPermission()).toBe("denied");
    expect(helperShutdowns).toBe(0);

    helperStatus = "granted";
    expect(await readScreenRecordingPermission()).toBe("granted");
    expect(helperShutdowns).toBe(1);

    // Still granted is not newly granted.
    expect(await readScreenRecordingPermission()).toBe("granted");
    expect(helperShutdowns).toBe(1);
  });

  test("a first read that finds the grant leaves the helper alone", async () => {
    helperStatus = "granted";
    await readScreenRecordingPermission();
    expect(helperShutdowns).toBe(0);
  });
});

describe("screenRecordingGranted", () => {
  test("trusts a grant it has seen, and reads again until it has", async () => {
    expect(await screenRecordingGranted()).toBe(false);
    expect(await screenRecordingGranted()).toBe(false);
    expect(helperReads).toBe(2);

    helperStatus = "granted";
    expect(await screenRecordingGranted()).toBe(true);
    expect(await screenRecordingGranted()).toBe(true);
    expect(helperReads).toBe(3);
  });
});

describe("answerScreenRecordingRefusal", () => {
  test("asks for the grant once per cooldown", async () => {
    let asks = 0;
    const ask = async () => {
      asks += 1;
    };

    await answerScreenRecordingRefusal(ask);
    await answerScreenRecordingRefusal(ask);

    expect(asks).toBe(1);
  });

  test("a refusal arriving while one is answered is the same refusal", async () => {
    let asks = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ask = async () => {
      asks += 1;
      await held;
    };

    const first = answerScreenRecordingRefusal(ask);
    await answerScreenRecordingRefusal(ask);
    release();
    await first;

    expect(asks).toBe(1);
  });

  test("a helper refusing a grant it has is let go instead", async () => {
    helperStatus = "granted";
    let asks = 0;

    await answerScreenRecordingRefusal(async () => {
      asks += 1;
    });

    expect(asks).toBe(0);
    expect(helperShutdowns).toBe(1);
  });

  test("a failure to ask is logged, not thrown", async () => {
    let asks = 0;
    await answerScreenRecordingRefusal(async () => {
      asks += 1;
      throw new Error("Settings would not open");
    });
    expect(asks).toBe(1);
  });
});
