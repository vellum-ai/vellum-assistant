/**
 * Pins the `deepMergeOverwrite` behaviour that the Action Overrides editor
 * depends on when it builds an `llm.callSites` patch (LUM-2949).
 *
 * A persisted call-site entry may carry tuning the web editor renders no
 * control for (`effort`, `thinking`, `maxTokens`, ...). The editor decides
 * per entry whether to send the picker triple, send `null`, or omit the key
 * entirely, and each of those choices is only correct because of how this
 * merge treats it. Asserting on the patch body alone would not catch a
 * change here, so the contract is pinned where it lives.
 */

import { describe, expect, test } from "bun:test";

import { deepMergeOverwrite } from "../config/loader.js";

type Raw = Record<string, unknown>;

function callSites(entries: Raw): Raw {
  return { llm: { callSites: entries } };
}

function mergedCallSites(before: Raw, patch: Raw): Raw {
  const raw = callSites(before);
  deepMergeOverwrite(raw, callSites(patch));
  return (raw.llm as Raw).callSites as Raw;
}

const TUNED = {
  profile: "latency-optimized",
  effort: "low",
  thinking: { enabled: false },
};

describe("llm.callSites patch merge", () => {
  test("an omitted key keeps its persisted value", () => {
    // What the editor sends for an active row: the picker triple only.
    const after = mergedCallSites(
      { voiceFrontDoor: TUNED },
      { voiceFrontDoor: { profile: "balanced", provider: null, model: null } },
    );
    expect(after.voiceFrontDoor).toEqual({
      profile: "balanced",
      effort: "low",
      thinking: { enabled: false },
    });
  });

  test("a null on an absent key is a no-op, not a write", () => {
    const after = mergedCallSites(
      { voiceFrontDoor: TUNED },
      { heartbeatAgent: null },
    );
    expect(after).toEqual({ voiceFrontDoor: TUNED });
  });

  test("a null deletes the whole entry, tuning included", () => {
    // Why the editor must not send `null` for a row the user left alone:
    // an entry holding only tuning would be erased.
    const after = mergedCallSites(
      { tuningOnly: { effort: "low", thinking: { enabled: false } } },
      { tuningOnly: null },
    );
    expect("tuningOnly" in after).toBe(false);
  });

  test("omitting a tuning-only entry leaves it untouched", () => {
    const before = {
      tuningOnly: { effort: "low", thinking: { enabled: false } },
    };
    const after = mergedCallSites(before, {
      heartbeatAgent: { profile: "balanced", provider: null, model: null },
    });
    expect(after.tuningOnly).toEqual({
      effort: "low",
      thinking: { enabled: false },
    });
  });

  test("an explicit null clears a scalar that is present", () => {
    // The picker triple relies on this to drop a stale provider/model pin.
    const after = mergedCallSites(
      { pinned: { provider: "anthropic", model: "claude-fable-5" } },
      { pinned: { profile: "balanced", provider: null, model: null } },
    );
    expect(after.pinned).toEqual({
      profile: "balanced",
      provider: null,
      model: null,
    });
  });
});
