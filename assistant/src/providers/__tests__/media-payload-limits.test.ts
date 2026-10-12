import { describe, expect, test } from "bun:test";

import {
  MEDIA_PAYLOAD_LIMITS,
  mediaPayloadLimitsFromConfig,
} from "../media-payload-limits.js";

const MB = 1024 * 1024;

describe("mediaPayloadLimitsFromConfig", () => {
  test("uses the shipped band when the workspace sets no payload cap", () => {
    expect(mediaPayloadLimitsFromConfig(undefined)).toBe(MEDIA_PAYLOAD_LIMITS);
    expect(mediaPayloadLimitsFromConfig({})).toBe(MEDIA_PAYLOAD_LIMITS);
  });

  test("replaces only the byte marks when a payload cap is set", () => {
    const limits = mediaPayloadLimitsFromConfig({
      payloadCap: { highMb: 22, lowMb: 14 },
    });
    expect(limits).toEqual({
      ...MEDIA_PAYLOAD_LIMITS,
      highBytes: 22 * MB,
      lowBytes: 14 * MB,
    });
  });
});
