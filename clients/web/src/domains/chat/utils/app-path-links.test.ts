import { describe, expect, test } from "bun:test";

import {
  isClientAppPath,
  toAppPathFromHref,
} from "@/domains/chat/utils/app-path-links";

describe("isClientAppPath", () => {
  test("accepts assistant and account routes", () => {
    expect(isClientAppPath("/assistant/conversations/conv-xyz")).toBe(true);
    expect(isClientAppPath("/assistant/schedules/schedule-1")).toBe(true);
    expect(isClientAppPath("/assistant")).toBe(true);
    expect(isClientAppPath("/account/login")).toBe(true);
    expect(isClientAppPath("/assistant/conversations/conv-xyz?tab=chat")).toBe(
      true,
    );
  });

  test("rejects workspace files and origin-escaping shapes", () => {
    expect(isClientAppPath("/workspace/scratch/a.png")).toBe(false);
    expect(isClientAppPath("//example.com/assistant/conversations/x")).toBe(
      false,
    );
    expect(isClientAppPath("/\\example.com/assistant/conversations/x")).toBe(
      false,
    );
    expect(isClientAppPath("assistant/conversations/conv-xyz")).toBe(false);
  });
});

describe("toAppPathFromHref", () => {
  test("returns relative client paths as written", () => {
    expect(toAppPathFromHref("/assistant/conversations/conv-xyz")).toBe(
      "/assistant/conversations/conv-xyz",
    );
    expect(
      toAppPathFromHref("/assistant/schedules/schedule-1?tab=runs#latest"),
    ).toBe("/assistant/schedules/schedule-1?tab=runs#latest");
  });

  test("maps vellum.ai http(s) URLs onto the client path", () => {
    expect(
      toAppPathFromHref(
        "https://www.vellum.ai/assistant/conversations/conv-xyz",
      ),
    ).toBe("/assistant/conversations/conv-xyz");
    expect(
      toAppPathFromHref(
        "https://app.vellum.ai/assistant/schedules/schedule-1?x=1",
      ),
    ).toBe("/assistant/schedules/schedule-1?x=1");
  });

  test("does not treat a foreign host's /assistant path as in-app", () => {
    expect(
      toAppPathFromHref("https://example.com/assistant/conversations/conv-xyz"),
    ).toBeNull();
  });

  test("rejects workspace and empty hrefs", () => {
    expect(toAppPathFromHref("/workspace/scratch/a.png")).toBeNull();
    expect(toAppPathFromHref("")).toBeNull();
    expect(toAppPathFromHref("https://www.vellum.ai/docs")).toBeNull();
  });
});
