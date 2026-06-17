import { describe, expect, test } from "bun:test";

import { routes } from "@/utils/routes";

describe("routes", () => {
  test("builds schedule settings detail URLs", () => {
    expect(routes.settings.schedule("schedule-123")).toBe(
      "/assistant/settings/schedules/schedule-123",
    );
  });

  test("builds schedule detail URLs for reserved system tasks", () => {
    expect(routes.settings.schedule("system-heartbeat")).toBe(
      "/assistant/settings/schedules/system-heartbeat",
    );
    expect(routes.settings.schedule("system-consolidation")).toBe(
      "/assistant/settings/schedules/system-consolidation",
    );
  });

  test("keeps the schedule settings list URL stable", () => {
    expect(routes.settings.schedules).toBe("/assistant/settings/schedules");
  });

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
});
