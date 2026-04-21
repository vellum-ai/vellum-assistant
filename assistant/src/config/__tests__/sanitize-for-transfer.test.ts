import { describe, expect, test } from "bun:test";

import { sanitizeConfigForTransfer } from "../sanitize-for-transfer.js";

function parse(json: string): Record<string, unknown> {
  return JSON.parse(json) as Record<string, unknown>;
}

describe("sanitizeConfigForTransfer", () => {
  test("returns the input unchanged when not valid JSON object", () => {
    expect(sanitizeConfigForTransfer("not json")).toBe("not json");
    expect(sanitizeConfigForTransfer("[]")).toBe("[]");
    expect(sanitizeConfigForTransfer("42")).toBe("42");
  });

  test("resets ingress.publicBaseUrl and deletes ingress.enabled", () => {
    const result = parse(
      sanitizeConfigForTransfer(
        JSON.stringify({
          ingress: {
            publicBaseUrl: "https://source.example.com",
            enabled: true,
          },
        }),
      ),
    );
    expect(result.ingress).toEqual({ publicBaseUrl: "" });
  });

  test("deletes daemon entirely", () => {
    const result = parse(
      sanitizeConfigForTransfer(
        JSON.stringify({ daemon: { port: 7000, host: "localhost" } }),
      ),
    );
    expect(result).not.toHaveProperty("daemon");
  });

  test("resets skills.load.extraDirs to []", () => {
    const result = parse(
      sanitizeConfigForTransfer(
        JSON.stringify({
          skills: { load: { extraDirs: ["/Users/alice/skills"] } },
        }),
      ),
    );
    expect(result.skills).toEqual({ load: { extraDirs: [] } });
  });

  test("deletes logFile.dir but preserves other logFile fields", () => {
    /**
     * logFile.dir is a source-host filesystem path — on a managed pod the
     * schema's platform-specific default is the correct value, so we strip
     * the stale one at bundle ingest rather than propagate it. Other
     * logFile fields (retentionDays, etc.) are host-agnostic and must
     * survive the transfer.
     */
    const result = parse(
      sanitizeConfigForTransfer(
        JSON.stringify({
          logFile: {
            dir: "/Users/alice/.local/share/vellum-dev/assistants/foo/logs",
            retentionDays: 14,
          },
        }),
      ),
    );
    expect(result.logFile).toEqual({ retentionDays: 14 });
  });

  test("leaves logFile untouched when dir is already absent", () => {
    const result = parse(
      sanitizeConfigForTransfer(
        JSON.stringify({ logFile: { retentionDays: 7 } }),
      ),
    );
    expect(result.logFile).toEqual({ retentionDays: 7 });
  });

  test("deletes hostBrowser.cdpInspect.desktopAuto while preserving siblings", () => {
    /**
     * hostBrowser.cdpInspect.desktopAuto is a macOS-host-only behavior.
     * Preserving a source-host-derived `enabled: true` inside a Linux
     * managed pod's config is misleading; the schema default restores
     * the correct per-platform value.
     */
    const result = parse(
      sanitizeConfigForTransfer(
        JSON.stringify({
          hostBrowser: {
            cdpInspect: {
              enabled: false,
              desktopAuto: { enabled: true, cooldownMs: 30000 },
              host: "127.0.0.1",
            },
          },
        }),
      ),
    );
    expect(result.hostBrowser).toEqual({
      cdpInspect: { enabled: false, host: "127.0.0.1" },
    });
  });

  test("is a no-op when hostBrowser or cdpInspect are absent", () => {
    expect(
      parse(sanitizeConfigForTransfer(JSON.stringify({ hostBrowser: {} }))),
    ).toEqual({ hostBrowser: {} });
    expect(
      parse(
        sanitizeConfigForTransfer(
          JSON.stringify({ hostBrowser: { cdpInspect: { enabled: true } } }),
        ),
      ),
    ).toEqual({ hostBrowser: { cdpInspect: { enabled: true } } });
  });

  test("applies every rule in one pass on a realistic config", () => {
    const source = JSON.stringify({
      ingress: { publicBaseUrl: "https://src.ngrok.app", enabled: true },
      daemon: { port: 7000 },
      skills: { load: { extraDirs: ["/Users/alice/skills"] } },
      logFile: { dir: "/Users/alice/logs", retentionDays: 30 },
      hostBrowser: { cdpInspect: { desktopAuto: { enabled: true } } },
      platform: { baseUrl: "" },
    });
    const result = parse(sanitizeConfigForTransfer(source));
    expect(result).toEqual({
      ingress: { publicBaseUrl: "" },
      skills: { load: { extraDirs: [] } },
      logFile: { retentionDays: 30 },
      hostBrowser: { cdpInspect: {} },
      platform: { baseUrl: "" },
    });
  });
});
