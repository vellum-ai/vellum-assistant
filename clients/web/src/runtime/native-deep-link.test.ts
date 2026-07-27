import { describe, expect, test } from "bun:test";

import { parseStartVoiceDeepLink } from "@/runtime/native-deep-link";

describe("parseStartVoiceDeepLink", () => {
  test("accepts every registered build-target scheme", () => {
    for (const scheme of [
      "vellum-assistant",
      "vellum-assistant-staging",
      "vellum-assistant-dev",
    ]) {
      expect(parseStartVoiceDeepLink(`${scheme}://voice?mode=new`)).toEqual({
        mode: "new",
      });
    }
  });

  test("parses mode=resume", () => {
    expect(
      parseStartVoiceDeepLink("vellum-assistant://voice?mode=resume"),
    ).toEqual({ mode: "resume" });
  });

  test("defaults a missing mode to new — a bare link still means 'start talking'", () => {
    expect(parseStartVoiceDeepLink("vellum-assistant://voice")).toEqual({
      mode: "new",
    });
  });

  test("defaults an unrecognized mode to new", () => {
    expect(
      parseStartVoiceDeepLink("vellum-assistant://voice?mode=teleport"),
    ).toEqual({ mode: "new" });
  });

  test("rejects look-alike schemes — a prefix match would let a hostile app in", () => {
    expect(
      parseStartVoiceDeepLink("vellum-assistant-evil://voice?mode=new"),
    ).toBeNull();
    expect(parseStartVoiceDeepLink("vellum://voice?mode=new")).toBeNull();
    expect(parseStartVoiceDeepLink("https://voice?mode=new")).toBeNull();
  });

  test("rejects other hosts on a valid scheme", () => {
    expect(
      parseStartVoiceDeepLink("vellum-assistant://oauth-complete"),
    ).toBeNull();
    expect(
      parseStartVoiceDeepLink("vellum-assistant://voices?mode=new"),
    ).toBeNull();
    expect(
      parseStartVoiceDeepLink("vellum-assistant://billing/voice"),
    ).toBeNull();
  });

  test("rejects unparseable URLs", () => {
    expect(parseStartVoiceDeepLink("::not-a-url")).toBeNull();
    expect(parseStartVoiceDeepLink("")).toBeNull();
  });
});
