/**
 * Which `services.stt.roles` entries count as a divergence worth showing.
 *
 * The comparison is the whole behaviour of the section: a role that resolves
 * to the global selection is not an override, and a role naming a different
 * model family on the same provider is.
 */
import { describe, expect, test } from "bun:test";

import { sttRoleOverrideEntries } from "@/components/speech/stt-role-overrides";

describe("sttRoleOverrideEntries", () => {
  test("an assistant with no roles field reports nothing", () => {
    // An assistant that does not serve the field at all reports no entries,
    // so the section does not render. That absence IS the compatibility
    // story: there is no version gate behind it.
    expect(sttRoleOverrideEntries({ provider: "vellum" })).toEqual([]);
    expect(sttRoleOverrideEntries(undefined)).toEqual([]);
  });

  test("a role naming the global provider is not an override", () => {
    expect(
      sttRoleOverrideEntries({
        provider: "deepgram",
        roles: { liveVoice: { provider: "deepgram" } },
      }),
    ).toEqual([]);
  });

  test("a role on another provider is an override", () => {
    expect(
      sttRoleOverrideEntries({
        provider: "openai-whisper",
        roles: { dictation: { provider: "deepgram" } },
      }),
    ).toEqual([{ role: "dictation", provider: "deepgram" }]);
  });

  test("a different model family on the same provider is an override", () => {
    // The case managed defaulting produces: live voice on Flux while the
    // global stays on the base family. Comparing providers alone would call
    // this identical and hide the one divergence that matters.
    expect(
      sttRoleOverrideEntries({
        provider: "vellum",
        providers: { vellum: { model: "nova-3" } },
        roles: { liveVoice: { provider: "vellum", model: "flux" } },
      }),
    ).toEqual([{ role: "liveVoice", provider: "vellum", model: "flux" }]);
  });

  test("a role repeating the global's own family is not an override", () => {
    expect(
      sttRoleOverrideEntries({
        provider: "vellum",
        providers: { vellum: { model: "flux" } },
        roles: { liveVoice: { provider: "vellum", model: "flux" } },
      }),
    ).toEqual([]);
  });

  test("reports every diverging role", () => {
    const entries = sttRoleOverrideEntries({
      provider: "vellum",
      roles: {
        liveVoice: { provider: "vellum", model: "flux" },
        batch: { provider: "vellum" },
        telephony: { provider: "deepgram" },
      },
    });

    expect(entries.map((e) => e.role).sort()).toEqual([
      "liveVoice",
      "telephony",
    ]);
  });

  test("a malformed role entry is skipped rather than rendered blank", () => {
    expect(
      sttRoleOverrideEntries({
        provider: "vellum",
        roles: { liveVoice: {}, batch: undefined },
      }),
    ).toEqual([]);
  });
});
