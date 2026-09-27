import { describe, expect, test } from "bun:test";

import { createMcpOAuthClientMetadataHandler } from "./mcp-oauth-client-metadata.js";

function config(values: { enabled?: boolean; publicBaseUrl?: string }) {
  return {
    getBoolean: () => values.enabled,
    getString: () => values.publicBaseUrl,
  };
}

describe("MCP OAuth client metadata", () => {
  test("publishes the direct OAuth callback for public HTTPS ingress", async () => {
    const handle = createMcpOAuthClientMetadataHandler(
      config({
        enabled: true,
        publicBaseUrl: "https://velay.example/assistant-123/",
      }),
    );

    const response = handle();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      client_id:
        "https://velay.example/assistant-123/oauth/client-metadata.json",
      redirect_uris: [
        "https://velay.example/assistant-123/webhooks/oauth/callback",
      ],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "Vellum Assistant",
      logo_uri: "https://www.vellum.ai/favicon.svg",
    });
  });

  test("publishes canonical URLs for equivalent ingress spellings", async () => {
    const handle = createMcpOAuthClientMetadataHandler(
      config({
        enabled: true,
        publicBaseUrl: "https://VELAY.EXAMPLE:443/a/../assistant-123///",
      }),
    );

    const response = handle();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      client_id:
        "https://velay.example/assistant-123/oauth/client-metadata.json",
      redirect_uris: [
        "https://velay.example/assistant-123/webhooks/oauth/callback",
      ],
    });
  });

  test("does not publish a document without HTTPS ingress", async () => {
    const handle = createMcpOAuthClientMetadataHandler(
      config({ publicBaseUrl: "http://localhost:8501/assistant-123" }),
    );

    const response = handle();

    expect(response.status).toBe(503);
  });

  test("does not publish a document when ingress is disabled", async () => {
    const handle = createMcpOAuthClientMetadataHandler(
      config({
        enabled: false,
        publicBaseUrl: "https://velay.example/assistant-123",
      }),
    );

    const response = handle();

    expect(response.status).toBe(503);
  });
});
