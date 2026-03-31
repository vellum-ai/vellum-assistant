import { describe, expect, mock, test } from "bun:test";

import {
  createMailRule,
  deleteMailRule,
  getAutoReplySettings,
  listMailRules,
  listMessagesDelta,
  updateAutoReplySettings,
} from "../messaging/providers/outlook/client.js";
import type {
  OutlookAutoReplySettings,
  OutlookDeltaResponse,
  OutlookMessage,
  OutlookMessageRule,
  OutlookMessageRuleListResponse,
} from "../messaging/providers/outlook/types.js";
import type { OAuthConnection } from "../oauth/connection.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function createMockConnection(
  responseBody: unknown = {},
  status = 200,
): OAuthConnection {
  return {
    id: "outlook-conn-1",
    providerKey: "outlook",
    accountInfo: "test@outlook.com",
    request: mock(() =>
      Promise.resolve({ status, headers: {}, body: responseBody }),
    ),
    withToken: <T>(fn: (token: string) => Promise<T>) =>
      fn("mock-access-token"),
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Outlook client — automation and delta APIs", () => {
  // ── listMailRules ──────────────────────────────────────────────────────

  describe("listMailRules", () => {
    test("returns rules array", async () => {
      const rules: OutlookMessageRule[] = [
        {
          id: "rule-1",
          displayName: "Move newsletters",
          sequence: 1,
          isEnabled: true,
          conditions: { subjectContains: ["newsletter"] },
          actions: { moveToFolder: "folder-123" },
        },
      ];
      const responseBody: OutlookMessageRuleListResponse = { value: rules };
      const conn = createMockConnection(responseBody);

      const result = await listMailRules(conn);

      expect(result.value).toHaveLength(1);
      expect(result.value![0].displayName).toBe("Move newsletters");
      expect(conn.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "GET",
          path: "/v1.0/me/mailFolders/inbox/messageRules",
        }),
      );
    });
  });

  // ── createMailRule ─────────────────────────────────────────────────────

  describe("createMailRule", () => {
    test("sends POST with rule body", async () => {
      const createdRule: OutlookMessageRule = {
        id: "rule-new",
        displayName: "Delete spam",
        sequence: 2,
        isEnabled: true,
        conditions: { senderContains: ["spam@"] },
        actions: { delete: true },
      };
      const conn = createMockConnection(createdRule);

      const rule = {
        displayName: "Delete spam",
        sequence: 2,
        isEnabled: true,
        conditions: { senderContains: ["spam@"] },
        actions: { delete: true },
      };
      const result = await createMailRule(conn, rule);

      expect(result.id).toBe("rule-new");
      expect(result.displayName).toBe("Delete spam");
      expect(conn.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "POST",
          path: "/v1.0/me/mailFolders/inbox/messageRules",
          body: rule,
        }),
      );
    });
  });

  // ── deleteMailRule ─────────────────────────────────────────────────────

  describe("deleteMailRule", () => {
    test("sends DELETE to correct path", async () => {
      const conn = createMockConnection(undefined, 204);

      await deleteMailRule(conn, "rule-42");

      expect(conn.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "DELETE",
          path: "/v1.0/me/mailFolders/inbox/messageRules/rule-42",
        }),
      );
    });
  });

  // ── getAutoReplySettings ──────────────────────────────────────────────

  describe("getAutoReplySettings", () => {
    test("returns settings", async () => {
      const settings: OutlookAutoReplySettings = {
        status: "alwaysEnabled",
        externalAudience: "all",
        internalReplyMessage: "I am out of office.",
        externalReplyMessage: "I am currently unavailable.",
      };
      const conn = createMockConnection(settings);

      const result = await getAutoReplySettings(conn);

      expect(result.status).toBe("alwaysEnabled");
      expect(result.externalAudience).toBe("all");
      expect(result.internalReplyMessage).toBe("I am out of office.");
      expect(conn.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "GET",
          path: "/v1.0/me/mailboxSettings/automaticRepliesSetting",
        }),
      );
    });
  });

  // ── updateAutoReplySettings ───────────────────────────────────────────

  describe("updateAutoReplySettings", () => {
    test("sends PATCH with wrapped settings", async () => {
      const conn = createMockConnection(undefined, 204);

      const settings: OutlookAutoReplySettings = {
        status: "scheduled",
        externalAudience: "contactsOnly",
        internalReplyMessage: "On vacation.",
        scheduledStartDateTime: {
          dateTime: "2024-12-20T00:00:00",
          timeZone: "UTC",
        },
        scheduledEndDateTime: {
          dateTime: "2024-12-31T23:59:59",
          timeZone: "UTC",
        },
      };

      await updateAutoReplySettings(conn, settings);

      expect(conn.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "PATCH",
          path: "/v1.0/me/mailboxSettings",
          body: { automaticRepliesSetting: settings },
        }),
      );
    });
  });

  // ── listMessagesDelta ─────────────────────────────────────────────────

  describe("listMessagesDelta", () => {
    test("initial fetch without deltaLink uses folder path with $select and $top", async () => {
      const deltaResponse: OutlookDeltaResponse<OutlookMessage> = {
        value: [
          {
            id: "msg-1",
            subject: "Hello",
            isRead: false,
            parentFolderId: "inbox-id",
          } as OutlookMessage,
        ],
        "@odata.deltaLink":
          "https://graph.microsoft.com/v1.0/me/mailFolders/inbox-id/messages/delta?$deltatoken=abc123",
      };
      const conn = createMockConnection(deltaResponse);

      const result = await listMessagesDelta(conn, "inbox-id");

      expect(result.value).toHaveLength(1);
      expect(result["@odata.deltaLink"]).toContain("$deltatoken=abc123");
      expect(conn.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "GET",
          path: "/v1.0/me/mailFolders/inbox-id/messages/delta",
          query: {
            $select:
              "id,subject,from,receivedDateTime,isRead,parentFolderId,conversationId,bodyPreview,hasAttachments",
            $top: "50",
          },
        }),
      );
    });

    test("follow-up fetch with deltaLink parses URL and uses query params", async () => {
      const deltaResponse: OutlookDeltaResponse<OutlookMessage> = {
        value: [
          {
            id: "msg-2",
            subject: "Update",
            isRead: true,
            parentFolderId: "inbox-id",
          } as OutlookMessage,
        ],
        "@odata.deltaLink":
          "https://graph.microsoft.com/v1.0/me/mailFolders/inbox-id/messages/delta?$deltatoken=def456",
      };
      const conn = createMockConnection(deltaResponse);

      const deltaLink =
        "https://graph.microsoft.com/v1.0/me/mailFolders/inbox-id/messages/delta?$deltatoken=abc123";
      const result = await listMessagesDelta(conn, "inbox-id", deltaLink);

      expect(result.value).toHaveLength(1);
      expect(result.value![0].id).toBe("msg-2");
      expect(conn.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "GET",
          path: "/v1.0/me/mailFolders/inbox-id/messages/delta",
          query: { $deltatoken: "abc123" },
        }),
      );
    });
  });
});
