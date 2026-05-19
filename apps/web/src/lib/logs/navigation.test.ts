import { describe, expect, test } from "bun:test";

import { LOGS_SIDEBAR } from "@/lib/logs/navigation.js";
import { routes } from "@/lib/routes.js";

describe("LOGS_SIDEBAR", () => {
  test("starts with Usage because Logs & Usage defaults to the usage page", () => {
    expect(LOGS_SIDEBAR[0]).toMatchObject({
      id: "usage",
      label: "Usage",
      href: routes.logs.usage,
    });
  });
});
