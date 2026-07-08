import { describe, expect, test } from "bun:test";

import { routes } from "@/utils/routes";

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

  test("builds the skills tab and per-skill detail paths", () => {
    expect(routes.skills.root).toBe("/assistant/skills");
    expect(routes.skills.detail("my-skill")).toBe("/assistant/skills/my-skill");
  });

  test("encodes namespaced skill ids into a single path segment", () => {
    // skills.sh catalog ids contain slashes (org/repo/skill); the produced
    // URL must keep the id as ONE segment so `skills/:skillId` can match it.
    expect(routes.skills.detail("org/repo/shared-skill")).toBe(
      "/assistant/skills/org%2Frepo%2Fshared-skill",
    );
  });
});
