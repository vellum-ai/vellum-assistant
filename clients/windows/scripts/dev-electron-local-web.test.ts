import { describe, expect, test } from "bun:test";

import { platformOriginFromDevUrl } from "./dev-electron-local-web";

describe("platformOriginFromDevUrl", () => {
  test("uses the remote origin without the renderer path", () => {
    expect(
      platformOriginFromDevUrl("https://dev-assistant.vellum.ai/assistant"),
    ).toBe("https://dev-assistant.vellum.ai");
  });

  test("rejects URLs that cannot serve the platform API", () => {
    expect(() => platformOriginFromDevUrl("file:///tmp/assistant")).toThrow(
      "VELLUM_DEV_URL must use http or https",
    );
  });
});
