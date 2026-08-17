import { describe, expect, test } from "bun:test";

import {
  collectDiagnostics,
  collectRedactedLogs,
  configureFeedback,
  type FeedbackDependencies,
} from "./feedback";

const dependencies = (
  overrides: Partial<FeedbackDependencies> = {},
): FeedbackDependencies => ({
  ipc: { handle: () => undefined },
  app: { getAppMetrics: () => [] },
  powerMonitor: { getSystemIdleTime: () => 12 },
  os: {
    release: () => "10.0.26100",
    type: () => "Windows_NT",
    totalmem: () => 16_000,
    freemem: () => 8_000,
  },
  readFile: async () => "",
  getVersionInfo: () => ({
    appName: "Vellum",
    version: "1.2.3",
    commitSha: "abc1234",
    releaseChannel: "staging",
  }),
  getLogFilePaths: () => [],
  getFeatureFlags: () => ({ featureA: true }),
  hasSession: () => false,
  ...overrides,
});

describe("collectDiagnostics", () => {
  test("reports Windows release metadata without requiring a session", () => {
    configureFeedback(dependencies());
    const result = collectDiagnostics();

    expect(result.app).toEqual({
      name: "Vellum",
      version: "1.2.3",
      commitSha: "abc1234",
      releaseChannel: "staging",
    });
    expect(result.platform).toMatchObject({
      arch: process.arch,
      release: "10.0.26100",
      type: "Windows_NT",
    });
    expect(result.session).toEqual({ authenticated: false });
  });

  test("reports only authenticated presence for a live session", () => {
    configureFeedback(
      dependencies({ hasSession: () => true }),
    );
    const result = collectDiagnostics();

    expect(result.session).toEqual({ authenticated: true });
    expect(Object.keys(result.session)).toEqual(["authenticated"]);
  });
});

describe("collectRedactedLogs", () => {
  test("skips unreadable files and redacts secrets and user paths", async () => {
    configureFeedback(
      dependencies({
        getLogFilePaths: () => ["missing.log", "vellum.log"],
        readFile: async (filePath) => {
          if (filePath === "missing.log") {
            throw new Error("missing");
          }
          return [
            "session_token=private-value",
            "user@example.com",
            "C:\\Users\\Alice\\AppData\\Local\\Vellum",
          ].join("\n");
        },
      }),
    );
    const result = await collectRedactedLogs();

    expect(result).toContain("session_token=[REDACTED]");
    expect(result).toContain("[REDACTED_EMAIL]");
    expect(result).toContain("~\\AppData\\Local\\Vellum");
    expect(result).not.toContain("private-value");
  });
});
