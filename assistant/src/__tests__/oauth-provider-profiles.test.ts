import { describe, expect, mock, test } from "bun:test";

mock.module("../security/secure-keys.js", () => ({
  deleteSecureKeyAsync: async () => "deleted" as const,
  setSecureKeyAsync: async () => true,
  getSecureKeyAsync: async () => undefined,
}));

import { getProvider } from "../oauth/oauth-store.js";
import { seedOAuthProviders } from "../oauth/seed-providers.js";
import { initializeDb } from "../persistence/db-init.js";

await initializeDb();
seedOAuthProviders();

describe("oauth provider profiles (DB-seeded)", () => {
  test("google provider row includes Drive, Sheets, and Slides in default scopes", () => {
    const provider = getProvider("google");

    expect(provider).toBeDefined();
    const scopes = JSON.parse(provider!.defaultScopes) as string[];
    expect(scopes).toContain("https://www.googleapis.com/auth/drive");
  });

  test("google provider row contains bearer injection templates for 8 Google API hosts", () => {
    const provider = getProvider("google");

    expect(provider).toBeDefined();
    expect(provider?.injectionTemplates).toBeDefined();

    const templates = JSON.parse(provider!.injectionTemplates!) as Array<{
      hostPattern: string;
      injectionType: string;
      headerName: string;
      valuePrefix: string;
    }>;

    expect(templates).toHaveLength(8);

    const byHost = new Map(templates.map((t) => [t.hostPattern, t]));

    for (const host of [
      "gmail.googleapis.com",
      "www.googleapis.com",
      "people.googleapis.com",
      "docs.googleapis.com",
      "sheets.googleapis.com",
      "slides.googleapis.com",
      "tasks.googleapis.com",
      "calendar.googleapis.com",
    ]) {
      const tpl = byHost.get(host);
      expect(tpl).toBeDefined();
      expect(tpl?.injectionType).toBe("header");
      expect(tpl?.headerName).toBe("Authorization");
      expect(tpl?.valuePrefix).toBe("Bearer ");
    }
  });
});
