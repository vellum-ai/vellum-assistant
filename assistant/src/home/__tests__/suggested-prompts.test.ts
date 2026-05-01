import { describe, expect, mock, test } from "bun:test";

// ─── Mocks ─────────────────────────────────────────────────────────────

let mockConnectedProviders = new Set<string>();

mock.module("../../oauth/oauth-store.js", () => ({
  isProviderConnected: async (provider: string) =>
    mockConnectedProviders.has(provider),
  listProviders: () => [
    { provider: "google" },
    { provider: "slack" },
    { provider: "notion" },
    { provider: "linear" },
    { provider: "github" },
  ],
}));

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

const { getSuggestedPrompts } = await import("../suggested-prompts.js");

// ─── Tests ─────────────────────────────────────────────────────────────

describe("getSuggestedPrompts", () => {
  test("shows 'Connect X' prompts when providers are disconnected", async () => {
    mockConnectedProviders = new Set();

    const prompts = await getSuggestedPrompts();
    const ids = prompts.map((p) => p.id);

    expect(ids).toContain("connect-google");
    expect(ids).toContain("connect-slack");
    expect(prompts.find((p) => p.id === "connect-google")!.label).toBe(
      "Connect Gmail",
    );
  });

  test("shows email management prompts when Google is connected", async () => {
    mockConnectedProviders = new Set(["google"]);

    const prompts = await getSuggestedPrompts();
    const ids = prompts.map((p) => p.id);

    // Should NOT show "Connect Gmail"
    expect(ids).not.toContain("connect-google");

    // Should show management prompts
    expect(ids).toContain("manage-google-triage-my-inbox");
    expect(ids).toContain("manage-google-summarize-today's-emails");

    const triage = prompts.find(
      (p) => p.id === "manage-google-triage-my-inbox",
    );
    expect(triage).toBeDefined();
    expect(triage!.label).toBe("Triage my inbox");
    expect(triage!.icon).toBe("mail");
    expect(triage!.source).toBe("deterministic");
  });

  test("still shows Connect prompts for disconnected providers alongside management prompts", async () => {
    mockConnectedProviders = new Set(["google"]);

    const prompts = await getSuggestedPrompts();
    const ids = prompts.map((p) => p.id);

    // Gmail management prompts
    expect(ids).toContain("manage-google-triage-my-inbox");
    // Slack still disconnected
    expect(ids).toContain("connect-slack");
  });

  test("providers without connectedPrompts show nothing when connected", async () => {
    mockConnectedProviders = new Set(["slack"]);

    const prompts = await getSuggestedPrompts();
    const ids = prompts.map((p) => p.id);

    // No connect prompt since connected
    expect(ids).not.toContain("connect-slack");
    // No management prompts since Slack doesn't define any
    expect(ids.filter((id) => id.startsWith("manage-slack"))).toHaveLength(0);
  });
});
