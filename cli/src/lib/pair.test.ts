import { describe, expect, test } from "bun:test";

import { REMOTE_WEB_PAIRING_CODE_TTL_MS } from "@vellumai/service-contracts/remote-web-pairing";

import { formatWebApproveFailure, parseGatewayErrorCode } from "./pair.js";

const GATEWAY_URL = "http://127.0.0.1:20100";
// Callers pass formatAssistantReference() output: display name plus stable ID.
const ASSISTANT_REFERENCE = "example-assistant (asst_0123456789abcdef)";
const ENV_NAME = "local";
const TTL_NOTE = `expire after ${Math.round(REMOTE_WEB_PAIRING_CODE_TTL_MS / 60_000)} minutes`;

describe("formatWebApproveFailure", () => {
  test("INVALID_USER_CODE names the gateway, assistant reference, and environment", () => {
    const message = formatWebApproveFailure(
      GATEWAY_URL,
      ASSISTANT_REFERENCE,
      ENV_NAME,
      "INVALID_USER_CODE",
    );
    expect(message).not.toBeNull();
    expect(message).toContain(`No such pairing code on ${GATEWAY_URL}`);
    expect(message).toContain(`assistant "${ASSISTANT_REFERENCE}"`);
    expect(message).toContain("asst_0123456789abcdef");
    expect(message).toContain(`environment "${ENV_NAME}"`);
  });

  test("INVALID_USER_CODE includes the TTL note and the cross-environment hint", () => {
    const message = formatWebApproveFailure(
      GATEWAY_URL,
      ASSISTANT_REFERENCE,
      ENV_NAME,
      "INVALID_USER_CODE",
    );
    expect(message).toContain(TTL_NOTE);
    expect(message).toContain("single-use");
    expect(message).toContain("different assistant or environment");
    expect(message).toContain("VELLUM_ENVIRONMENT");
  });

  test("EXPIRED_USER_CODE gets the same diagnostic with an expiry lead line", () => {
    const message = formatWebApproveFailure(
      GATEWAY_URL,
      ASSISTANT_REFERENCE,
      ENV_NAME,
      "EXPIRED_USER_CODE",
    );
    expect(message).toContain(`Pairing code expired on ${GATEWAY_URL}`);
    expect(message).toContain(TTL_NOTE);
    expect(message).toContain("VELLUM_ENVIRONMENT");
  });

  test("unknown error codes return null so callers fall back to the generic HTTP error", () => {
    for (const code of ["RATE_LIMITED", "BAD_REQUEST", "", null]) {
      expect(
        formatWebApproveFailure(
          GATEWAY_URL,
          ASSISTANT_REFERENCE,
          ENV_NAME,
          code,
        ),
      ).toBeNull();
    }
  });
});

describe("parseGatewayErrorCode", () => {
  test("extracts the code from a gateway error envelope", () => {
    const body = JSON.stringify({
      error: { code: "INVALID_USER_CODE", message: "invalid pairing code" },
    });
    expect(parseGatewayErrorCode(body)).toBe("INVALID_USER_CODE");
  });

  test("returns null for non-JSON bodies", () => {
    expect(parseGatewayErrorCode("Not Found")).toBeNull();
    expect(parseGatewayErrorCode("")).toBeNull();
  });

  test("returns null when the envelope carries no string code", () => {
    expect(parseGatewayErrorCode(JSON.stringify({ error: {} }))).toBeNull();
    expect(
      parseGatewayErrorCode(JSON.stringify({ error: { code: 404 } })),
    ).toBeNull();
    expect(parseGatewayErrorCode(JSON.stringify({}))).toBeNull();
  });
});
