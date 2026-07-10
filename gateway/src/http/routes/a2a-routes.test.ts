import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Workspace dir mock -----------------------------------------------------

let testWorkspaceDir: string;

mock.module("../../credential-reader.js", () => ({
  getWorkspaceDir: () => testWorkspaceDir,
}));

// Import after mocks are registered
const { createAgentCardHandler } = await import("./a2a-routes.js");

// --- Helpers ---------------------------------------------------------------

function makeConfigFileCache(overrides?: {
  a2aEnabled?: boolean;
  publicBaseUrl?: string;
}) {
  const data: Record<string, Record<string, unknown>> = {
    a2a: { enabled: overrides?.a2aEnabled ?? false },
    ingress: {
      publicBaseUrl: overrides?.publicBaseUrl ?? "https://example.com",
    },
  };

  return {
    getBoolean: (section: string, field: string) => {
      const val = data[section]?.[field];
      return typeof val === "boolean" ? val : undefined;
    },
    getString: (section: string, field: string) => {
      const val = data[section]?.[field];
      return typeof val === "string" ? val : undefined;
    },
  } as import("../../config-file-cache.js").ConfigFileCache;
}

// --- Setup / teardown -------------------------------------------------------

beforeEach(() => {
  testWorkspaceDir = mkdtempSync(join(tmpdir(), "a2a-test-"));
});

afterEach(() => {
  rmSync(testWorkspaceDir, { recursive: true, force: true });
});

// --- Tests -----------------------------------------------------------------

describe("Agent Card", () => {
  it("returns 404 when A2A is not enabled", async () => {
    const configFile = makeConfigFileCache({ a2aEnabled: false });
    const handler = createAgentCardHandler(configFile);

    const res = await handler(
      new Request("http://localhost:7830/.well-known/agent-card.json"),
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("not enabled");
  });

  it("serves agent card with fallback name when no IDENTITY.md", async () => {
    const configFile = makeConfigFileCache({
      a2aEnabled: true,
      publicBaseUrl: "https://my-assistant.example.com",
    });
    const handler = createAgentCardHandler(configFile);

    const res = await handler(
      new Request("http://localhost:7830/.well-known/agent-card.json"),
    );

    expect(res.status).toBe(200);
    const card = (await res.json()) as {
      name: string;
      supported_interfaces: Array<{ url: string }>;
      capabilities: { push_notifications: boolean };
    };
    expect(card.name).toBe("Vellum Assistant");
    expect(card.supported_interfaces[0].url).toBe(
      "https://my-assistant.example.com/a2a/message:send",
    );
    expect(card.capabilities.push_notifications).toBe(true);
  });

  it("reads assistant name from IDENTITY.md", async () => {
    const promptsDir = join(testWorkspaceDir, "prompts");
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(
      join(promptsDir, "IDENTITY.md"),
      "**Name:** Alice\n\nA helpful research assistant.",
    );

    const configFile = makeConfigFileCache({
      a2aEnabled: true,
      publicBaseUrl: "https://alice.example.com",
    });
    const handler = createAgentCardHandler(configFile);

    const res = await handler(
      new Request("http://localhost:7830/.well-known/agent-card.json"),
    );

    expect(res.status).toBe(200);
    const card = (await res.json()) as { name: string; description: string };
    expect(card.name).toBe("Alice");
    expect(card.description).toBe("Alice — a Vellum AI assistant");
  });

  it("returns 503 when no public base URL is configured", async () => {
    const configFile = makeConfigFileCache({
      a2aEnabled: true,
      publicBaseUrl: "",
    });
    const handler = createAgentCardHandler(configFile);

    const res = await handler(
      new Request("http://localhost:7830/.well-known/agent-card.json"),
    );

    expect(res.status).toBe(503);
  });
});
