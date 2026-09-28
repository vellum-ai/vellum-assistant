import { afterEach, describe, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";

import { LS_FEATURE_INTRO_SEEN_PREFIX } from "@/utils/local-settings-keys";

import {
  markFeatureIntroSeen,
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
});
