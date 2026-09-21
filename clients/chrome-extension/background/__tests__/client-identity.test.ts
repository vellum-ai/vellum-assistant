import { describe, expect, test } from "bun:test";

import { clientCapabilityHeaders } from "../client-identity.js";

describe("clientCapabilityHeaders", () => {
  test("sends version and watchdog fingerprint", () => {
    expect(clientCapabilityHeaders("0.12.1", true)).toEqual({
      "X-Vellum-Client-Version": "0.12.1",
      "X-Vellum-Sse-Watchdog": "1",
    });
  });

  test("omits version and watchdog when they are absent", () => {
    expect(clientCapabilityHeaders(undefined, false)).toEqual({});
  });
});
