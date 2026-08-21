/**
 * Tests for the config `vellum client --interface web` serves at
 * `/assistant/__config`. It is the same document the nginx tunnel edge serves,
 * and a caller probes it to learn which assistant an origin fronts, so the two
 * producers must agree on carrying `assistantId`.
 */
import { describe, expect, test } from "bun:test";

import { buildWebInterfaceConfig } from "../commands/client.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../lib/constants.js";

const BASE = {
  webUrl: "https://app.example.com",
  platformUrl: "https://platform.example.com",
  disablePlatform: true,
};

describe("vellum client web __config", () => {
  test("stamps the assistant the front is bound to", () => {
    expect(
      buildWebInterfaceConfig({ ...BASE, assistantId: "assistant-1" }),
    ).toEqual({ ...BASE, assistantId: "assistant-1" });
  });

  test("omits the daemon-internal placeholder so a probe reads an unknown identity", () => {
    expect(
      buildWebInterfaceConfig({
        ...BASE,
        assistantId: DAEMON_INTERNAL_ASSISTANT_ID,
      }),
    ).toEqual(BASE);
  });

  test("omits an absent assistant id", () => {
    expect(buildWebInterfaceConfig(BASE)).toEqual(BASE);
  });
});
