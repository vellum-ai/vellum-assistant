/**
 * Tests for IntegrationDetailModal OAuth completion helpers.
 *
 * These helpers are intentionally pure: Bun's `mock.module` is process-global,
 * and full-suite component rendering can be polluted by unrelated test files.
 */

import { describe, expect, test } from "bun:test";

import type { OAuthConnection } from "@/generated/api/types.gen.js";
import {
  type OAuthCompletePayload,
  getOAuthCompleteMessagePayload,
  getOAuthCompleteStoragePayload,
  getProviderConnectionSignatures,
  hasNewOrChangedProviderConnection,
  oauthCompletionStorageKey,
} from "@/components/app/settings/integration-detail-modal.js";

const TEST_REQUEST_ID = "test-request-id-12345";
const TEST_ORIGIN = "http://localhost:3000";

function oauthConnection(
  overrides: Partial<OAuthConnection> = {},
): OAuthConnection {
  return {
    id: "conn-123",
    provider: "github",
    status: "ACTIVE",
    connected: true,
    account_label: "user@example.com",
    scopes_granted: [],
    expires_at: null,
    ...overrides,
  };
}

describe("IntegrationDetailModal - postMessage validation", () => {
  test("ignores messages from wrong origin", () => {
    const payload = getOAuthCompleteMessagePayload(
      new MessageEvent("message", {
        origin: "http://evil.com",
        data: {
          type: "vellum:oauth-complete",
          requestId: TEST_REQUEST_ID,
          oauthStatus: "connected",
        },
      }),
      TEST_ORIGIN,
      TEST_REQUEST_ID,
    );

    expect(payload).toBeNull();
  });

  test("ignores messages with wrong type", () => {
    const payload = getOAuthCompleteMessagePayload(
      new MessageEvent("message", {
        origin: TEST_ORIGIN,
        data: {
          type: "wrong-type",
          requestId: TEST_REQUEST_ID,
          oauthStatus: "connected",
        },
      }),
      TEST_ORIGIN,
      TEST_REQUEST_ID,
    );

    expect(payload).toBeNull();
  });

  test("ignores messages with mismatched requestId", () => {
    const payload = getOAuthCompleteMessagePayload(
      new MessageEvent("message", {
        origin: TEST_ORIGIN,
        data: {
          type: "vellum:oauth-complete",
          requestId: "unknown-request-id",
          oauthStatus: "connected",
        },
      }),
      TEST_ORIGIN,
      TEST_REQUEST_ID,
    );

    expect(payload).toBeNull();
  });

  test("accepts valid messages with correct origin, type, and requestId", () => {
    const messagePayload: OAuthCompletePayload = {
      type: "vellum:oauth-complete",
      requestId: TEST_REQUEST_ID,
      oauthStatus: "connected",
      oauthProvider: "github",
      oauthCode: null,
    };
    const payload = getOAuthCompleteMessagePayload(
      new MessageEvent("message", {
        origin: TEST_ORIGIN,
        data: messagePayload,
      }),
      TEST_ORIGIN,
      TEST_REQUEST_ID,
    );

    expect(payload).toEqual(messagePayload);
  });

  test("accepts valid storage fallback with correct requestId", () => {
    const storagePayload: OAuthCompletePayload = {
      type: "vellum:oauth-complete",
      requestId: TEST_REQUEST_ID,
      oauthStatus: "connected",
      oauthProvider: "github",
      oauthCode: null,
    };
    const payload = getOAuthCompleteStoragePayload(
      new StorageEvent("storage", {
        key: oauthCompletionStorageKey(TEST_REQUEST_ID),
        newValue: JSON.stringify(storagePayload),
      }),
      TEST_REQUEST_ID,
    );

    expect(payload).toEqual(storagePayload);
  });

  test("detects a newly created provider connection", () => {
    const baseline = getProviderConnectionSignatures([], "github");

    expect(
      hasNewOrChangedProviderConnection(
        [oauthConnection()],
        "github",
        baseline,
      ),
    ).toBe(true);
  });

  test("does not treat an existing unchanged provider connection as success", () => {
    const existingConnection = oauthConnection();
    const baseline = getProviderConnectionSignatures(
      [existingConnection],
      "github",
    );

    expect(
      hasNewOrChangedProviderConnection(
        [existingConnection],
        "github",
        baseline,
      ),
    ).toBe(false);
  });

  test("detects an updated provider connection", () => {
    const existingConnection = oauthConnection({
      expires_at: "2026-05-04T20:00:00Z",
    });
    const baseline = getProviderConnectionSignatures(
      [existingConnection],
      "github",
    );

    expect(
      hasNewOrChangedProviderConnection(
        [
          {
            ...existingConnection,
            expires_at: "2026-05-04T21:00:00Z",
          },
        ],
        "github",
        baseline,
      ),
    ).toBe(true);
  });
});
