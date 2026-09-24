import { describe, expect, test } from "bun:test";

import {
  buildMcpOAuthCallbackUrl,
  buildMcpOAuthClientMetadata,
  buildMcpOAuthClientMetadataUrl,
} from "../mcp-oauth.js";

describe("MCP OAuth client metadata", () => {
  test("builds the public client document", () => {
    expect(
      buildMcpOAuthClientMetadata({
        clientId:
          "https://velay.example/assistant-123/oauth/client-metadata.json",
        redirectUris: [
          "https://velay.example/assistant-123/webhooks/oauth/callback",
        ],
      }),
    ).toEqual({
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

  test("builds callback and metadata URLs from one normalized base", () => {
    const baseUrl = "https://velay.example/assistant-123///";
    expect(buildMcpOAuthCallbackUrl(baseUrl)).toBe(
      "https://velay.example/assistant-123/webhooks/oauth/callback",
    );
    expect(buildMcpOAuthClientMetadataUrl(baseUrl)).toBe(
      "https://velay.example/assistant-123/oauth/client-metadata.json",
    );
  });
});
