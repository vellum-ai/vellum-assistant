import { describe, expect, test } from "bun:test";

import {
  pickSecondReachTool,
  SECOND_REACH_TOOLS,
} from "@/domains/onboarding/cast/cast-tools";

describe("pickSecondReachTool", () => {
  test("picks GitHub for an engineering role", () => {
    expect(pickSecondReachTool("Software Engineer", "char-1").slug).toBe(
      "github",
    );
  });

  test("picks Figma for a designer", () => {
    expect(pickSecondReachTool("Designer", "char-1").slug).toBe("figma");
  });

  test("never offers Google Calendar (it is always the first slot)", () => {
    for (const role of ["Software Engineer", "Designer", "Astronaut", ""]) {
      expect(pickSecondReachTool(role, "char-1").slug).not.toBe(
        "google-calendar",
      );
    }
  });

  test("falls back to a deterministic candidate when the role matches nothing", () => {
    const a = pickSecondReachTool("Astronaut", "char-1");
    const b = pickSecondReachTool("Astronaut", "char-1");
    expect(a.slug).toBe(b.slug);
    expect(SECOND_REACH_TOOLS).toContain(a);
  });

  test("falls back deterministically for an empty role too", () => {
    const tool = pickSecondReachTool("", "char-7");
    expect(SECOND_REACH_TOOLS).toContain(tool);
  });
});
