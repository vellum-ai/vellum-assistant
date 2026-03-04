import { describe, expect, test } from "bun:test";

import {
  getProviderProfile,
  resolveService,
} from "../oauth/provider-profiles.js";

describe("oauth provider profiles", () => {
  test("gmail profile defines bearer injection templates for Google API hosts", () => {
    const service = resolveService("gmail");
    const profile = getProviderProfile(service);

    expect(service).toBe("integration:gmail");
    expect(profile).toBeDefined();
    expect(profile?.injectionTemplates).toBeDefined();
    expect(profile?.injectionTemplates).toHaveLength(3);

    const byHost = new Map(
      (profile?.injectionTemplates ?? []).map((t) => [t.hostPattern, t]),
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
