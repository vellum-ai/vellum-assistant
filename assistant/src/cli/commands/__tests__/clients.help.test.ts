import { describe, expect, test } from "bun:test";

import {
  HOST_PROXY_SUPPORT,
  hostProxyCapabilities,
} from "../../../types/host-capabilities.js";
import { clientsHelp } from "../clients.help.js";

describe("clients help capability matrix", () => {
  const helpText = clientsHelp.helpText ?? "";

  test("renders every capability of every host-capable client", () => {
    for (const id of Object.keys(HOST_PROXY_SUPPORT)) {
      const capabilities = hostProxyCapabilities(id);
      expect(capabilities.length).toBeGreaterThan(0);
      for (const capability of capabilities) {
        expect(helpText).toContain(capability);
      }
    }
  });

  test("does not offer clients that provide no host capabilities", () => {
    // The assistant reads this text to decide what to tell a user to install.
    // Naming a client with no host capabilities next to the download link
    // sends them to something that cannot unblock the task.
    for (const id of ["ios", "android", "web", "cli"]) {
      expect(hostProxyCapabilities(id)).toEqual([]);
    }
    expect(helpText).toContain("provides no host");
  });

  test("points at the canonical downloads page", () => {
    expect(helpText).toContain("https://www.vellum.ai/downloads");
  });
});
