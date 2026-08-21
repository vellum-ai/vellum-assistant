/**
 * Tests for the config `vellum client --interface web` serves at
 * `/assistant/__config`, the document a caller probes to learn which assistant
 * an origin fronts. This host also serves the `__local` endpoints, so its SPA
 * switches between every assistant in the lockfile and the origin has no single
 * identity to report: the config must stay free of an `assistantId`, matching
 * the Vite dev server's local-mode plugin.
 */
import { describe, expect, test } from "bun:test";

import { buildWebInterfaceConfig } from "../commands/client.js";

const BASE = {
  webUrl: "https://app.example.com",
  platformUrl: "https://platform.example.com",
  disablePlatform: true,
};

describe("vellum client web __config", () => {
  test("reports no assistant identity for the multi-assistant origin", () => {
    const config = buildWebInterfaceConfig(BASE);

    expect(config).toEqual(BASE);
    // A stamped id would be the launch-time one, so a probe for any other
    // assistant this origin serves would read a false `foreign`.
    expect(config).not.toHaveProperty("assistantId");
  });
});
