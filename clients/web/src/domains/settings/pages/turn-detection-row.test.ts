import { describe, expect, test } from "bun:test";

import { turnDetectionOn } from "@/domains/settings/pages/turn-detection-row";

describe("turnDetectionOn", () => {
  test("managed live voice with nothing named is on", () => {
    expect(turnDetectionOn({ provider: "vellum" }, "vellum", true)).toBe(true);
  });

  test("the global managed family does not turn it off", () => {
    // Managed defaulting writes the base family globally for batch and
    // telephony; the daemon still runs live voice on the turn-detecting one.
    const stt = {
      provider: "vellum",
      providers: { vellum: { model: "nova-3" } },
    };
    expect(turnDetectionOn(stt, "vellum", true)).toBe(true);
  });

  test("a managed live-voice role naming the base family is off", () => {
    const stt = {
      provider: "vellum",
      roles: { liveVoice: { provider: "vellum", model: "nova-3" } },
    };
    expect(turnDetectionOn(stt, "vellum", true)).toBe(false);
  });

  test("a language the family cannot serve is off while unset", () => {
    expect(turnDetectionOn({ provider: "vellum" }, "vellum", false)).toBe(
      false,
    );
  });

  test("a BYOK provider follows its global family", () => {
    const flux = {
      provider: "deepgram",
      providers: { deepgram: { model: "flux" } },
    };
    const nova = {
      provider: "deepgram",
      providers: { deepgram: { model: "nova-3" } },
    };
    expect(turnDetectionOn(flux, "deepgram", true)).toBe(true);
    expect(turnDetectionOn(nova, "deepgram", true)).toBe(false);
    expect(turnDetectionOn({ provider: "deepgram" }, "deepgram", true)).toBe(
      false,
    );
  });
});
