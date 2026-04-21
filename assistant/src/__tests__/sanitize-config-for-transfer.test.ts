import { describe, expect, test } from "bun:test";

import { sanitizeConfigForTransfer } from "../config/sanitize-for-transfer.js";

describe("sanitizeConfigForTransfer", () => {
  test("strips every host-specific field group in one pass", () => {
    const input = {
      ingress: {
        publicBaseUrl: "https://example.com",
        enabled: true,
        webhook: { path: "/hook" },
      },
      daemon: { port: 3000, logLevel: "debug" },
      skills: {
        load: {
          extraDirs: ["/custom/skills"],
          builtIn: true,
        },
      },
      logFile: {
        dir: "/Users/alice/.local/share/vellum-dev/assistants/foo/logs",
        retentionDays: 14,
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
    expect(result.daemon).toBeUndefined();
    expect(result.skills.load.extraDirs).toEqual([]);
    expect(result.logFile).toEqual({ retentionDays: 14 });
    expect(result.hostBrowser).toEqual({
      cdpInspect: { enabled: false, host: "127.0.0.1" },
    });
  });

  test("deletes logFile.dir but preserves host-agnostic logFile fields", () => {
    /**
     * logFile.dir is a source-host filesystem path — on a managed pod
     * the schema's platform-specific default is the correct value, so
     * we strip the stale one at bundle ingest rather than propagate it.
     * Other logFile fields (retentionDays, etc.) are host-agnostic and
     * must survive the transfer.
     */
    const input = {
      logFile: {
        dir: "/Users/alice/logs",
        retentionDays: 30,
      },
    };

    const result = JSON.parse(sanitizeConfigForTransfer(JSON.stringify(input)));

    expect(result.logFile).toEqual({ retentionDays: 30 });
  });

  test("leaves logFile untouched when dir is absent", () => {
    const result = JSON.parse(
      sanitizeConfigForTransfer(
        JSON.stringify({ logFile: { retentionDays: 7 } }),
      ),
    );
    expect(result.logFile).toEqual({ retentionDays: 7 });
  });

  test("deletes hostBrowser.cdpInspect.desktopAuto but preserves siblings", () => {
    /**
     * hostBrowser.cdpInspect.desktopAuto is macOS-host-only behavior.
     * Preserving a source-host-derived `enabled: true` inside a Linux
     * managed pod's config is misleading; the schema default restores
     * the correct per-platform value.
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

  test("preserves nested ingress fields other than publicBaseUrl and enabled", () => {
    const input = {
      ingress: {
        publicBaseUrl: "https://old.url",
        enabled: false,
        webhook: { path: "/webhook", secret: "abc" },
        rateLimit: { max: 50, window: 60 },
      },
    };

    const result = JSON.parse(sanitizeConfigForTransfer(JSON.stringify(input)));

    expect(result.ingress.webhook).toEqual({ path: "/webhook", secret: "abc" });
    expect(result.ingress.rateLimit).toEqual({ max: 50, window: 60 });
    expect(result.ingress.publicBaseUrl).toBe("");
    expect(result.ingress.enabled).toBeUndefined();
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
