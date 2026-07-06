import { describe, expect, test } from "bun:test";

import {
  isConversationChatPath,
  isConversationPath,
  routes,
} from "@/utils/routes";

describe("routes", () => {
  test("builds schedule-filtered usage URLs", () => {
    expect(routes.logs.usageForSchedule("schedule-123")).toBe(
      "/assistant/logs/usage?range=7d&groupBy=schedule&scheduleId=schedule-123",
    );
  });

  test("encodes schedule ids in usage URLs", () => {
    expect(routes.logs.usageForSchedule("schedule with spaces")).toBe(
      "/assistant/logs/usage?range=7d&groupBy=schedule&scheduleId=schedule+with+spaces",
    );
  });

  test("builds the schedules tab and per-schedule detail paths", () => {
    expect(routes.schedules.root).toBe("/assistant/schedules");
    expect(routes.schedules.detail("sch_123")).toBe(
      "/assistant/schedules/sch_123",
    );
  });
});

describe("isConversationPath (conversation area, subroutes included)", () => {
  test("matches the chat index and conversation routes", () => {
    expect(isConversationPath("/assistant")).toBe(true);
    expect(isConversationPath("/assistant/")).toBe(true);
    expect(isConversationPath(routes.conversation("conv-1"))).toBe(true);
  });

  test("matches conversation subroutes like the inspector", () => {
    expect(isConversationPath(routes.inspect("conv-1"))).toBe(true);
  });

  test("rejects non-conversation routes", () => {
    expect(isConversationPath("/assistant/home")).toBe(false);
    expect(isConversationPath("/assistant/library")).toBe(false);
  });
});

describe("isConversationChatPath (composer-mounting routes only)", () => {
  test("matches the chat index (draft conversation)", () => {
    expect(isConversationChatPath("/assistant")).toBe(true);
    expect(isConversationChatPath("/assistant/")).toBe(true);
  });

  test("matches a bare conversation route, tolerating a trailing slash", () => {
    expect(isConversationChatPath(routes.conversation("conv-1"))).toBe(true);
    expect(
      isConversationChatPath(`${routes.conversation("conv-1")}/`),
    ).toBe(true);
  });

  test("rejects the inspector subroute — InspectPage has no composer", () => {
    expect(isConversationChatPath(routes.inspect("conv-1"))).toBe(false);
  });

  test("rejects the conversations list prefix without an id", () => {
    expect(isConversationChatPath(`${routes.conversations}/`)).toBe(false);
  });

  test("rejects non-conversation routes", () => {
    expect(isConversationChatPath("/assistant/home")).toBe(false);
    expect(isConversationChatPath("/assistant/library")).toBe(false);
  });
});
