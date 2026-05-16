import { describe, it, expect } from "bun:test";

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

  it("serves agent card when enabled", async () => {
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
