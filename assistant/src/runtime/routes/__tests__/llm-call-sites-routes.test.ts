import { describe, expect, test } from "bun:test";

import { LLMCallSiteEnum } from "../../../config/schemas/llm.js";
import { ROUTES } from "../llm-call-sites-routes.js";

const route = ROUTES.find((r) => r.operationId === "llm_call_sites_list")!;

describe("llm-call-sites-routes", () => {
  test("route is defined with correct method and endpoint", () => {
    expect(route).toBeDefined();
    expect(route.method).toBe("GET");
    expect(route.endpoint).toBe("config/llm/call-sites");
  });

  test("response has domains and callSites arrays", async () => {
    const result = (await route.handler({})) as {
      domains: unknown[];
      callSites: unknown[];
    };
    expect(Array.isArray(result.domains)).toBe(true);
    expect(Array.isArray(result.callSites)).toBe(true);
  });

  test("all call site IDs match LLMCallSiteEnum", async () => {
    const result = (await route.handler({})) as {
      callSites: Array<{ id: string; displayName: string; description: string; domain: string }>;
    };
    const validIds = new Set(LLMCallSiteEnum.options);
    for (const site of result.callSites) {
      expect(validIds.has(site.id as never)).toBe(true);
      expect(site.displayName).toBeTruthy();
      expect(site.description).toBeTruthy();
    }
    expect(result.callSites.length).toBe(LLMCallSiteEnum.options.length);
  });

  test("all call site domain references match defined domains", async () => {
    const result = (await route.handler({})) as {
      domains: Array<{ id: string; displayName: string }>;
      callSites: Array<{ id: string; domain: string }>;
    };
    const domainIds = new Set(result.domains.map((d) => d.id));
    for (const site of result.callSites) {
      expect(domainIds.has(site.domain)).toBe(true);
    }
  });

  test("domains have non-empty id and displayName", async () => {
    const result = (await route.handler({})) as {
      domains: Array<{ id: string; displayName: string }>;
    };
    expect(result.domains.length).toBeGreaterThan(0);
    for (const domain of result.domains) {
      expect(domain.id).toBeTruthy();
      expect(domain.displayName).toBeTruthy();
    }
  });
});
