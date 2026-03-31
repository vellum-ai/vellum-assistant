import { describe, expect, mock, test } from "bun:test";

import type {
  OutlookAutoReplySettings,
  OutlookMessageRule,
  OutlookMessageRuleListResponse,
} from "../messaging/providers/outlook/types.js";
import type { OAuthConnection } from "../oauth/connection.js";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const listMailRulesMock = mock<() => Promise<OutlookMessageRuleListResponse>>();
const createMailRuleMock =
  mock<
    (
      connection: OAuthConnection,
      rule: Omit<OutlookMessageRule, "id">,
    ) => Promise<OutlookMessageRule>
  >();
const deleteMailRuleMock =
  mock<(connection: OAuthConnection, ruleId: string) => Promise<void>>();
const getAutoReplySettingsMock =
  mock<() => Promise<OutlookAutoReplySettings>>();
const updateAutoReplySettingsMock =
  mock<
    (
      connection: OAuthConnection,
      settings: OutlookAutoReplySettings,
    ) => Promise<void>
  >();

mock.module("../messaging/providers/outlook/client.js", () => ({
  listMailRules: (...args: unknown[]) => listMailRulesMock(...(args as [])),
  createMailRule: (...args: unknown[]) =>
    createMailRuleMock(
      ...(args as [OAuthConnection, Omit<OutlookMessageRule, "id">]),
    ),
  deleteMailRule: (...args: unknown[]) =>
    deleteMailRuleMock(...(args as [OAuthConnection, string])),
  getAutoReplySettings: (...args: unknown[]) =>
    getAutoReplySettingsMock(...(args as [])),
  updateAutoReplySettings: (...args: unknown[]) =>
    updateAutoReplySettingsMock(
      ...(args as [OAuthConnection, OutlookAutoReplySettings]),
    ),
}));

const fakeConnection = {} as OAuthConnection;

mock.module("../oauth/connection-resolver.js", () => ({
  resolveOAuthConnection: () => fakeConnection,
}));

import { run as runRules } from "../config/bundled-skills/outlook/tools/outlook-rules.js";
import { run as runVacation } from "../config/bundled-skills/outlook/tools/outlook-vacation.js";
import type { ToolContext } from "../tools/types.js";

const ctx: ToolContext = {
  workingDir: "/tmp",
  conversationId: "test-conversation",
  trustClass: "guardian",
};

// ── outlook_rules: list ──────────────────────────────────────────────────────

describe("outlook_rules list", () => {
  test("returns no rules message when list is empty", async () => {
    listMailRulesMock.mockResolvedValueOnce({ value: [] });
    const result = await runRules({ action: "list" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toBe("No inbox rules configured.");
  });

  test("returns formatted rule summaries", async () => {
    listMailRulesMock.mockResolvedValueOnce({
      value: [
        {
          id: "rule-1",
          displayName: "Archive newsletters",
          sequence: 1,
          isEnabled: true,
          conditions: { senderContains: ["newsletter@"] },
          actions: { moveToFolder: "archive-folder-id", markAsRead: true },
        },
        {
          id: "rule-2",
          displayName: "Flag urgent",
          sequence: 2,
          isEnabled: false,
          conditions: { importance: "high" },
          actions: { markImportance: "high" },
        },
      ],
    });

    const result = await runRules({ action: "list" }, ctx);
    expect(result.isError).toBe(false);

    const parsed = JSON.parse(result.content);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe("rule-1");
    expect(parsed[0].displayName).toBe("Archive newsletters");
    expect(parsed[0].isEnabled).toBe(true);
    expect(parsed[0].conditions).toContain("sender contains: newsletter@");
    expect(parsed[0].actions).toContain("move to folder: archive-folder-id");
    expect(parsed[0].actions).toContain("mark as read");
    expect(parsed[1].id).toBe("rule-2");
    expect(parsed[1].isEnabled).toBe(false);
  });
});

// ── outlook_rules: create ────────────────────────────────────────────────────

describe("outlook_rules create", () => {
  test("creates a rule with conditions and actions", async () => {
    createMailRuleMock.mockResolvedValueOnce({
      id: "new-rule-1",
      displayName: "Auto-archive spam",
      sequence: 1,
      isEnabled: true,
      conditions: { senderContains: ["spam@"] },
      actions: { moveToFolder: "junk-folder-id" },
    });

    const result = await runRules(
      {
        action: "create",
        display_name: "Auto-archive spam",
        from_contains: "spam@",
        move_to_folder: "junk-folder-id",
        confidence: 0.95,
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toBe("Rule created (ID: new-rule-1).");
    expect(createMailRuleMock).toHaveBeenCalledTimes(1);
  });

  test("rejects create without display_name", async () => {
    const result = await runRules(
      { action: "create", from_contains: "test@", confidence: 0.9 },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("display_name is required");
  });

  test("rejects create without conditions", async () => {
    const result = await runRules(
      {
        action: "create",
        display_name: "Empty rule",
        move_to_folder: "folder-id",
        confidence: 0.9,
      },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("At least one condition is required");
  });

  test("handles array conditions", async () => {
    createMailRuleMock.mockResolvedValueOnce({
      id: "rule-arr",
      displayName: "Multi-sender",
      sequence: 1,
      isEnabled: true,
      conditions: { senderContains: ["alice@", "bob@"] },
      actions: { markAsRead: true },
    });

    const result = await runRules(
      {
        action: "create",
        display_name: "Multi-sender",
        from_contains: ["alice@", "bob@"],
        mark_as_read: true,
        confidence: 0.9,
      },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Rule created");
  });

  test("creates rule with forward_to action", async () => {
    createMailRuleMock.mockResolvedValueOnce({
      id: "rule-fwd",
      displayName: "Forward urgent",
      sequence: 1,
      isEnabled: true,
      conditions: { importance: "high" },
      actions: {
        forwardTo: [{ emailAddress: { address: "boss@example.com" } }],
      },
    });

    const result = await runRules(
      {
        action: "create",
        display_name: "Forward urgent",
        importance: "high",
        forward_to: "boss@example.com",
        confidence: 0.9,
      },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Rule created");

    const callArgs = createMailRuleMock.mock.calls.at(-1)!;
    const rule = callArgs[1] as Omit<OutlookMessageRule, "id">;
    expect(rule.actions?.forwardTo).toEqual([
      { emailAddress: { address: "boss@example.com" } },
    ]);
  });
});

// ── outlook_rules: delete ────────────────────────────────────────────────────

describe("outlook_rules delete", () => {
  test("deletes a rule by ID", async () => {
    deleteMailRuleMock.mockResolvedValueOnce(undefined);

    const result = await runRules(
      { action: "delete", rule_id: "rule-1", confidence: 0.9 },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe("Rule deleted.");
    expect(deleteMailRuleMock).toHaveBeenCalledWith(fakeConnection, "rule-1");
  });

  test("rejects delete without rule_id", async () => {
    const result = await runRules({ action: "delete", confidence: 0.9 }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("rule_id is required");
  });
});

// ── outlook_rules: errors ────────────────────────────────────────────────────

describe("outlook_rules error handling", () => {
  test("returns error for missing action", async () => {
    const result = await runRules({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("action is required");
  });

  test("returns error for unknown action", async () => {
    const result = await runRules({ action: "unknown" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Unknown action "unknown"');
  });
});

// ── outlook_vacation: get ────────────────────────────────────────────────────

describe("outlook_vacation get", () => {
  test("returns current auto-reply settings", async () => {
    const settings: OutlookAutoReplySettings = {
      status: "disabled",
      externalAudience: "none",
    };
    getAutoReplySettingsMock.mockResolvedValueOnce(settings);

    const result = await runVacation({ action: "get" }, ctx);
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.status).toBe("disabled");
    expect(parsed.externalAudience).toBe("none");
  });

  test("returns scheduled settings with messages", async () => {
    const settings: OutlookAutoReplySettings = {
      status: "scheduled",
      externalAudience: "all",
      internalReplyMessage: "I'm on vacation",
      externalReplyMessage: "Out of office until Jan 5",
      scheduledStartDateTime: {
        dateTime: "2025-01-01T00:00:00",
        timeZone: "America/New_York",
      },
      scheduledEndDateTime: {
        dateTime: "2025-01-05T00:00:00",
        timeZone: "America/New_York",
      },
    };
    getAutoReplySettingsMock.mockResolvedValueOnce(settings);

    const result = await runVacation({ action: "get" }, ctx);
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.status).toBe("scheduled");
    expect(parsed.internalReplyMessage).toBe("I'm on vacation");
    expect(parsed.scheduledStartDateTime.dateTime).toBe("2025-01-01T00:00:00");
  });
});

// ── outlook_vacation: enable ─────────────────────────────────────────────────

describe("outlook_vacation enable", () => {
  test("enables always-on auto-reply", async () => {
    updateAutoReplySettingsMock.mockResolvedValueOnce(undefined);

    const result = await runVacation(
      {
        action: "enable",
        internal_message: "I'm currently away from my desk.",
        confidence: 0.9,
      },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe("Auto-reply enabled.");

    const callArgs = updateAutoReplySettingsMock.mock.calls.at(-1)!;
    const settings = callArgs[1] as OutlookAutoReplySettings;
    expect(settings.status).toBe("alwaysEnabled");
    expect(settings.internalReplyMessage).toBe(
      "I'm currently away from my desk.",
    );
    expect(settings.externalAudience).toBe("none");
  });

  test("enables scheduled auto-reply with date range", async () => {
    updateAutoReplySettingsMock.mockResolvedValueOnce(undefined);

    const result = await runVacation(
      {
        action: "enable",
        internal_message: "On vacation until Jan 5.",
        external_message: "Out of office.",
        external_audience: "all",
        start_date: "2025-01-01T00:00:00",
        end_date: "2025-01-05T00:00:00",
        time_zone: "America/New_York",
        confidence: 0.9,
      },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe("Auto-reply enabled.");

    const callArgs = updateAutoReplySettingsMock.mock.calls.at(-1)!;
    const settings = callArgs[1] as OutlookAutoReplySettings;
    expect(settings.status).toBe("scheduled");
    expect(settings.externalAudience).toBe("all");
    expect(settings.externalReplyMessage).toBe("Out of office.");
    expect(settings.scheduledStartDateTime).toEqual({
      dateTime: "2025-01-01T00:00:00",
      timeZone: "America/New_York",
    });
    expect(settings.scheduledEndDateTime).toEqual({
      dateTime: "2025-01-05T00:00:00",
      timeZone: "America/New_York",
    });
  });

  test("rejects enable without internal_message", async () => {
    const result = await runVacation(
      { action: "enable", confidence: 0.9 },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("internal_message is required");
  });

  test("uses alwaysEnabled when only start_date provided (no end_date)", async () => {
    updateAutoReplySettingsMock.mockResolvedValueOnce(undefined);

    const result = await runVacation(
      {
        action: "enable",
        internal_message: "Away",
        start_date: "2025-01-01T00:00:00",
        confidence: 0.9,
      },
      ctx,
    );
    expect(result.isError).toBe(false);

    const callArgs = updateAutoReplySettingsMock.mock.calls.at(-1)!;
    const settings = callArgs[1] as OutlookAutoReplySettings;
    expect(settings.status).toBe("alwaysEnabled");
  });
});

// ── outlook_vacation: disable ────────────────────────────────────────────────

describe("outlook_vacation disable", () => {
  test("disables auto-reply", async () => {
    updateAutoReplySettingsMock.mockResolvedValueOnce(undefined);

    const result = await runVacation(
      { action: "disable", confidence: 0.9 },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe("Auto-reply disabled.");

    const callArgs = updateAutoReplySettingsMock.mock.calls.at(-1)!;
    const settings = callArgs[1] as OutlookAutoReplySettings;
    expect(settings.status).toBe("disabled");
    expect(settings.externalAudience).toBe("none");
  });
});

// ── outlook_vacation: errors ─────────────────────────────────────────────────

describe("outlook_vacation error handling", () => {
  test("returns error for missing action", async () => {
    const result = await runVacation({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("action is required");
  });

  test("returns error for unknown action", async () => {
    const result = await runVacation({ action: "unknown" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Unknown action "unknown"');
  });
});
