import { afterEach, describe, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";

import { LS_FEATURE_INTRO_SEEN_PREFIX } from "@/utils/local-settings-keys";
import { withRejectedWrites } from "@/utils/rejected-writes.test-helper";

import {
  FEATURE_INTRO_LAUNCHED_AT,
  markFeatureIntroSeen,
  predatesFeatureIntro,
  readFeatureIntroSeen,
  useFeatureIntroSeen,
} from "./use-feature-intro-seen";

const KEY = `${LS_FEATURE_INTRO_SEEN_PREFIX}assistant-email`;

afterEach(() => {
  localStorage.clear();
});

describe("useFeatureIntroSeen", () => {
  test("starts unseen and persists the dismissal", () => {
    const { result } = renderHook(() => useFeatureIntroSeen("assistant-email"));
    expect(result.current.seen).toBe(false);

    act(() => {
      result.current.markSeen();
    });
    expect(result.current.seen).toBe(true);
    expect(localStorage.getItem(KEY)).toBe("1");
  });

  test("a device that already saw it stays seen across mounts", () => {
    markFeatureIntroSeen("assistant-email");
    const { result } = renderHook(() => useFeatureIntroSeen("assistant-email"));
    expect(result.current.seen).toBe(true);
    expect(readFeatureIntroSeen("assistant-email")).toBe(true);
  });

  test("an unexpected stored value reads as unseen", () => {
    localStorage.setItem(KEY, "yes");
    expect(readFeatureIntroSeen("assistant-email")).toBe(false);
  });

  test("a dismissal the device cannot keep still closes the modal", () => {
    const { result } = renderHook(() => useFeatureIntroSeen("assistant-email"));
    expect(result.current.seen).toBe(false);
    withRejectedWrites(() => {
      act(() => {
        result.current.markSeen();
      });
    });
    expect(result.current.seen).toBe(true);
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});

describe("predatesFeatureIntro", () => {
  const launch = Date.parse(FEATURE_INTRO_LAUNCHED_AT["assistant-email"]);

  test("an account from before the launch is owed the intro", () => {
    const before = new Date(launch - 24 * 60 * 60 * 1000).toISOString();
    expect(predatesFeatureIntro(before, "assistant-email")).toBe(true);
  });

  test("an account from the launch on is not", () => {
    const at = new Date(launch).toISOString();
    const after = new Date(launch + 60 * 1000).toISOString();
    expect(predatesFeatureIntro(at, "assistant-email")).toBe(false);
    expect(predatesFeatureIntro(after, "assistant-email")).toBe(false);
  });

  test("an unknown or unreadable date withholds the intro", () => {
    expect(predatesFeatureIntro(null, "assistant-email")).toBe(false);
    expect(predatesFeatureIntro(undefined, "assistant-email")).toBe(false);
    expect(predatesFeatureIntro("", "assistant-email")).toBe(false);
    expect(predatesFeatureIntro("yesterday", "assistant-email")).toBe(false);
  });
});
