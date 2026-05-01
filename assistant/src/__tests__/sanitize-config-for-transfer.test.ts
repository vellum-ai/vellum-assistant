import { describe, expect, test } from "bun:test";

import { sanitizeConfigForTransfer } from "../config/sanitize-for-transfer.js";

describe("sanitizeConfigForTransfer", () => {
  test("strips every host-specific field group in one pass", () => {
    const input = {
      ingress: {
        publicBaseUrl: "https://example.com",
        enabled: true,
        twilioPublicBaseUrl: "https://velay-public.example.test",
        twilioPublicBaseUrlManagedBy: "velay",
        webhook: { path: "/hook" },
      },
      daemon: { port: 3000, logLevel: "debug" },
      skills: {
        load: {
          extraDirs: ["/custom/skills"],
          builtIn: true,
        },
      },
      hostBrowser: {
        cdpInspect: {
          enabled: false,
          desktopAuto: { enabled: true, cooldownMs: 30000 },
          host: "127.0.0.1",
        },
      },
      name: "my-assistant",
    };

    const result = JSON.parse(sanitizeConfigForTransfer(JSON.stringify(input)));

    expect(result.ingress.publicBaseUrl).toBe("");
    expect(result.ingress.enabled).toBeUndefined();
    expect(result.ingress.twilioPublicBaseUrl).toBeUndefined();
    expect(result.ingress.twilioPublicBaseUrlManagedBy).toBeUndefined();
    expect(result.daemon).toBeUndefined();
    expect(result.skills.load.extraDirs).toEqual([]);
    expect(result.hostBrowser).toEqual({
      cdpInspect: { enabled: false, host: "127.0.0.1" },
    });
  });

  test("deletes desktopAuto when the source relies on the schema default (enabled: true)", () => {
    /**
     * hostBrowser.cdpInspect.desktopAuto is macOS-host-only behavior.
     * Preserving a source-host-derived `enabled: true` inside a Linux
     * managed pod's config is misleading; the schema default restores
     * the correct per-platform value when the subobject is absent.
     */
    const input = {
      hostBrowser: {
        cdpInspect: {
          enabled: false,
          desktopAuto: { enabled: true, cooldownMs: 30000 },
          host: "127.0.0.1",
        },
      },
    };

    const result = JSON.parse(sanitizeConfigForTransfer(JSON.stringify(input)));

    expect(result.hostBrowser).toEqual({
      cdpInspect: { enabled: false, host: "127.0.0.1" },
    });
  });

  test("preserves desktopAuto when the source explicitly opted out (enabled: false)", () => {
    /**
     * The schema default for `desktopAuto.enabled` is `true`, so
     * unconditionally stripping the subobject would silently re-enable
     * auto-attach after a platform→local teleport for users who
     * deliberately turned it off. Preserve explicit opt-outs.
     */
    const input = {
      hostBrowser: {
        cdpInspect: {
          desktopAuto: { enabled: false, cooldownMs: 60000 },
        },
      },
    };

    const result = JSON.parse(sanitizeConfigForTransfer(JSON.stringify(input)));

    expect(result.hostBrowser).toEqual({
      cdpInspect: { desktopAuto: { enabled: false, cooldownMs: 60000 } },
    });
  });

  test("deletes desktopAuto when enabled is unspecified (also relies on default)", () => {
    const input = {
      hostBrowser: {
        cdpInspect: {
          desktopAuto: { cooldownMs: 45000 },
        },
      },
    };

    const result = JSON.parse(sanitizeConfigForTransfer(JSON.stringify(input)));

    expect(result.hostBrowser).toEqual({ cdpInspect: {} });
  });

  test("is a no-op when hostBrowser has no cdpInspect subtree", () => {
    const result = JSON.parse(
      sanitizeConfigForTransfer(JSON.stringify({ hostBrowser: {} })),
    );
    expect(result.hostBrowser).toEqual({});
  });

  test("preserves non-target fields unchanged", () => {
    const input = {
      name: "test",
      model: "claude-3",
      ingress: {
        publicBaseUrl: "https://example.com",
        enabled: true,
        webhook: { path: "/hook" },
        rateLimit: { max: 100 },
      },
      daemon: { port: 3000 },
      skills: {
        load: {
          extraDirs: ["/dir"],
          builtIn: true,
        },
        catalog: ["skill-a"],
      },
      memory: { enabled: true },
    };

    const result = JSON.parse(sanitizeConfigForTransfer(JSON.stringify(input)));

    expect(result.name).toBe("test");
    expect(result.model).toBe("claude-3");
    expect(result.memory).toEqual({ enabled: true });
    expect(result.skills.catalog).toEqual(["skill-a"]);
    expect(result.skills.load.builtIn).toBe(true);
  });

  test("strips Velay-managed Twilio ingress state during transfer", () => {
    const input = {
      ingress: {
        publicBaseUrl: "https://old.url",
        enabled: true,
        twilioPublicBaseUrl: "https://velay-public.example.test",
        twilioPublicBaseUrlManagedBy: "velay",
        webhook: { path: "/webhook" },
      },
    };

    const result = JSON.parse(sanitizeConfigForTransfer(JSON.stringify(input)));

    expect(result.ingress).toEqual({
      publicBaseUrl: "",
      webhook: { path: "/webhook" },
    });
  });

  test("preserves nested ingress fields other than environment-specific URL state", () => {
    const input = {
      ingress: {
        publicBaseUrl: "https://old.url",
        enabled: false,
        twilioPublicBaseUrl: "https://velay-public.example.test",
        twilioPublicBaseUrlManagedBy: "velay",
        webhook: { path: "/webhook", secret: "abc" },
        rateLimit: { max: 50, window: 60 },
      },
    };

    const result = JSON.parse(sanitizeConfigForTransfer(JSON.stringify(input)));

    expect(result.ingress.webhook).toEqual({ path: "/webhook", secret: "abc" });
    expect(result.ingress.rateLimit).toEqual({ max: 50, window: 60 });
    expect(result.ingress.publicBaseUrl).toBe("");
    expect(result.ingress.enabled).toBeUndefined();
    expect(result.ingress.twilioPublicBaseUrl).toBeUndefined();
    expect(result.ingress.twilioPublicBaseUrlManagedBy).toBeUndefined();
  });

  test("handles config missing some target fields", () => {
    const input = {
      name: "test",
      ingress: { webhook: { path: "/hook" } },
    };

    const result = JSON.parse(sanitizeConfigForTransfer(JSON.stringify(input)));

    expect(result.name).toBe("test");
    expect(result.ingress.publicBaseUrl).toBe("");
    expect(result.ingress.webhook).toEqual({ path: "/hook" });
  });

  test("handles config missing all target fields", () => {
    const input = {
      name: "test",
      model: "claude-3",
    };

    const result = JSON.parse(sanitizeConfigForTransfer(JSON.stringify(input)));

    expect(result.name).toBe("test");
    expect(result.model).toBe("claude-3");
  });

  test("handles empty object", () => {
    const result = sanitizeConfigForTransfer("{}");
    expect(JSON.parse(result)).toEqual({});
  });

  test("handles invalid JSON by returning original string", () => {
    const malformed = "{ not valid json }}}";
    const result = sanitizeConfigForTransfer(malformed);
    expect(result).toBe(malformed);
  });

  test("handles JSON null by returning original string", () => {
    const result = sanitizeConfigForTransfer("null");
    expect(result).toBe("null");
  });

  test("handles JSON array by returning original string", () => {
    const result = sanitizeConfigForTransfer("[1, 2, 3]");
    expect(result).toBe("[1, 2, 3]");
  });

  test("output uses 2-space indentation with trailing newline", () => {
    const input = { name: "test" };
    const result = sanitizeConfigForTransfer(JSON.stringify(input));

    expect(result).toBe(JSON.stringify(input, null, 2) + "\n");
    expect(result.endsWith("\n")).toBe(true);
  });
});
