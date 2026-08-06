import { describe, it, expect } from "bun:test";

import { stampSlackEventTeam } from "./event-team.js";

describe("stampSlackEventTeam", () => {
  it("stamps a string team_id onto an event with no team", () => {
    const event: { team?: string } = {};
    stampSlackEventTeam(event, "T0WORKSPACE");
    expect(event.team).toBe("T0WORKSPACE");
  });

  it("leaves an existing event-level team untouched (it takes precedence)", () => {
    const event: { team?: string } = { team: "T0EVENTLEVEL" };
    stampSlackEventTeam(event, "T0PAYLOAD");
    expect(event.team).toBe("T0EVENTLEVEL");
  });

  it("ignores a non-string team_id rather than writing garbage identity", () => {
    // `team_id` comes from an unvalidated JSON.parse; a non-string value must
    // not be stamped, or it would flow into `actor.teamId` as garbage.
    const event: { team?: string } = {};
    stampSlackEventTeam(event, { nested: "object" } as unknown);
    expect(event.team).toBeUndefined();
  });

  it("ignores a missing team_id", () => {
    const event: { team?: string } = {};
    stampSlackEventTeam(event, undefined);
    expect(event.team).toBeUndefined();
  });

  it("ignores an empty-string team_id", () => {
    const event: { team?: string } = {};
    stampSlackEventTeam(event, "");
    expect(event.team).toBeUndefined();
  });
});
