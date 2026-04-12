import { describe, test, expect } from "bun:test";
import { buildSchema } from "../schema.js";

function handleRequest(req: Request): Response {
  const url = new URL(req.url);

  if (url.pathname === "/schema") {
    return Response.json(buildSchema());
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}

describe("/schema route", () => {
  test("returns valid OpenAPI 3.1 schema via HTTP", async () => {
    /**
     * Tests that the /schema endpoint returns a valid OpenAPI document with
     * the correct version and expected top-level structure.
     */

    // GIVEN a running gateway server

    // WHEN we request the schema endpoint
    const res = handleRequest(new Request("http://gateway.test/schema"));

    // THEN we receive a 200 with valid JSON
    expect(res.status).toBe(200);
    const body = await res.json();

    // AND the response is an OpenAPI 3.1 document
    expect(body.openapi).toBe("3.1.0");
    expect(body.info.title).toBe("Vellum Gateway");
    expect(typeof body.info.version).toBe("string");

    // AND it contains the expected top-level sections
    expect(body.paths).toBeDefined();
    expect(body.components).toBeDefined();
    expect(body.components.schemas).toBeDefined();
    expect(body.components.securitySchemes).toBeDefined();
  });

  test("schema includes all gateway routes", async () => {
    /**
     * Tests that the schema documents every route the gateway exposes.
     */

    // GIVEN a running gateway server

    // WHEN we request the schema endpoint
    const res = handleRequest(new Request("http://gateway.test/schema"));
    const body = await res.json();

    // THEN the paths include every gateway endpoint
    expect(body.paths["/healthz"]).toBeDefined();
    expect(body.paths["/readyz"]).toBeDefined();
    expect(body.paths["/schema"]).toBeDefined();
    expect(body.paths["/v1/health"]).toBeDefined();
    expect(body.paths["/v1/healthz"]).toBeDefined();
    expect(body.paths["/webhooks/telegram"]).toBeDefined();
    expect(body.paths["/webhooks/twilio/voice"]).toBeDefined();
    expect(body.paths["/webhooks/twilio/status"]).toBeDefined();
    expect(body.paths["/webhooks/twilio/connect-action"]).toBeDefined();
    expect(body.paths["/webhooks/twilio/relay"]).toBeDefined();
    expect(body.paths["/webhooks/twilio/media-stream"]).toBeDefined();
    expect(body.paths["/webhooks/oauth/callback"]).toBeDefined();
    expect(body.paths["/v1/integrations/telegram/config"]).toBeDefined();
    expect(body.paths["/v1/integrations/telegram/commands"]).toBeDefined();
    expect(body.paths["/v1/integrations/telegram/setup"]).toBeDefined();
    expect(body.paths["/v1/oauth/apps"]).toBeDefined();
    expect(body.paths["/v1/oauth/apps/{appId}"]).toBeDefined();
    expect(body.paths["/v1/oauth/apps/{appId}/connections"]).toBeDefined();
    expect(body.paths["/v1/oauth/connections/{connectionId}"]).toBeDefined();
    expect(body.paths["/v1/oauth/apps/{appId}/connect"]).toBeDefined();
    expect(body.paths["/v1/contacts"]).toBeDefined();
    expect(body.paths["/v1/contacts/merge"]).toBeDefined();
    expect(body.paths["/v1/contact-channels/{contactChannelId}"]).toBeDefined();
    expect(body.paths["/v1/contacts/{contactId}"]).toBeDefined();
    expect(body.paths["/v1/contacts/invites"]).toBeDefined();
    expect(body.paths["/v1/contacts/invites/redeem"]).toBeDefined();
    expect(body.paths["/v1/contacts/invites/{inviteId}"]).toBeDefined();
    expect(body.paths["/v1/channel-verification-sessions"]).toBeDefined();
    expect(
      body.paths["/v1/channel-verification-sessions/status"],
    ).toBeDefined();
    expect(
      body.paths["/v1/channel-verification-sessions/resend"],
    ).toBeDefined();
    expect(
      body.paths["/v1/channel-verification-sessions/revoke"],
    ).toBeDefined();
    expect(body.paths["/deliver/telegram"]).toBeDefined();
    expect(body.paths["/{path}"]).toBeDefined();
  });

  test("schema version matches package.json version", async () => {
    /**
     * Tests that the schema info.version stays in sync with package.json.
     */

    // GIVEN the version from package.json
    const pkg = (await import("../../package.json")).default;

    // WHEN we request the schema endpoint
    const res = handleRequest(new Request("http://gateway.test/schema"));
    const body = await res.json();

    // THEN the schema version matches the package version
    expect(body.info.version).toBe(pkg.version);
  });
});

describe("buildSchema()", () => {
  test("returns a plain object with all component schemas", () => {
    /**
     * Tests that buildSchema() includes all expected component schema
     * definitions for request/response types.
     */

    // GIVEN no special setup needed

    // WHEN we call buildSchema directly
    const schema = buildSchema();

    // THEN it contains all expected component schemas
    const components = schema.components as Record<
      string,
      Record<string, unknown>
    >;
    const schemaNames = Object.keys(components.schemas);
    expect(schemaNames).toContain("HealthResponse");
    expect(schemaNames).toContain("ReadyResponse");
    expect(schemaNames).toContain("DrainingResponse");
    expect(schemaNames).toContain("ErrorResponse");
    expect(schemaNames).toContain("TelegramOk");
    expect(schemaNames).toContain("TelegramUpdate");
    expect(schemaNames).toContain("TelegramMessage");
    expect(schemaNames).toContain("TelegramPhotoSize");
    expect(schemaNames).toContain("TelegramDocument");
    expect(schemaNames).toContain("TelegramDeliverRequest");
    expect(schemaNames).toContain("RuntimeAttachmentMeta");

    const oauthConnection = components.schemas.OAuthConnectionSummary as {
      properties?: Record<string, unknown>;
    };
    expect(oauthConnection.properties?.granted_scopes).toEqual({
      type: "array",
      items: { type: "string" },
    });
    expect(oauthConnection.properties?.has_refresh_token).toEqual({
      type: "boolean",
    });
  });

  test("returns a JSON-serializable object", () => {
    /**
     * Tests that the schema can be round-tripped through JSON without loss.
     */

    // GIVEN no special setup needed

    // WHEN we serialize and deserialize the schema
    const schema = buildSchema();
    const json = JSON.stringify(schema);
    const parsed = JSON.parse(json);

    // THEN the round-tripped object equals the original
    expect(parsed).toEqual(schema);
  });

  test("TelegramDeliverRequest supports typing chatAction payloads", () => {
    const schema = buildSchema();
    const components = schema.components as {
      schemas: Record<
        string,
        {
          properties?: Record<string, unknown>;
          anyOf?: Array<Record<string, unknown>>;
        }
      >;
    };
    const telegramDeliver = components.schemas.TelegramDeliverRequest;

    expect(telegramDeliver.properties?.chatAction).toEqual({
      type: "string",
      enum: ["typing"],
      description:
        "Optional Telegram chat action to emit (currently only `typing`)",
    });
    expect(telegramDeliver.anyOf).toContainEqual({ required: ["chatAction"] });
  });
});
