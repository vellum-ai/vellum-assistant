import { describe, expect, test } from "bun:test";

import { getProviderBehavior } from "../oauth/provider-behaviors.js";

describe("oauth provider behaviors", () => {
  test("google behavior defines bearer injection templates for Google API hosts", () => {
    const behavior = getProviderBehavior("google");

    expect(behavior).toBeDefined();
    expect(behavior?.injectionTemplates).toBeDefined();
    expect(behavior?.injectionTemplates).toHaveLength(3);

    const byHost = new Map(
      (behavior?.injectionTemplates ?? []).map((t) => [t.hostPattern, t]),
    );

    for (const host of [
      "gmail.googleapis.com",
      "www.googleapis.com",
      "people.googleapis.com",
    ]) {
      const tpl = byHost.get(host);
      expect(tpl).toBeDefined();
      expect(tpl?.injectionType).toBe("header");
      expect(tpl?.headerName).toBe("Authorization");
      expect(tpl?.valuePrefix).toBe("Bearer ");
    }
  });
});
