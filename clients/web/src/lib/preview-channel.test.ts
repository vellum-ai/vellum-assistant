import { afterEach, describe, expect, test } from "bun:test";

import {
  PREVIEW_COOKIE,
  getRunningChannel,
  isPreviewRequested,
  setPreviewRequested,
} from "@/lib/preview-channel";

// Readonly at the type level only; the underlying object is writable at runtime.
const env = import.meta.env as Record<string, string | undefined>;

afterEach(() => {
  setPreviewRequested(false);
  delete env.VITE_CHANNEL;
  delete env.VITE_APP_VERSION;
});

describe("preview cookie", () => {
  test("is absent until requested", () => {
    expect(isPreviewRequested()).toBe(false);
  });

  test("round-trips through the cookie jar", () => {
    setPreviewRequested(true);
    expect(document.cookie).toContain(`${PREVIEW_COOKIE}=1`);
    expect(isPreviewRequested()).toBe(true);

    setPreviewRequested(false);
    expect(document.cookie).not.toContain(`${PREVIEW_COOKIE}=1`);
    expect(isPreviewRequested()).toBe(false);
  });

  test("ignores a cookie whose name merely ends in the preview name", () => {
    document.cookie = `not_${PREVIEW_COOKIE}=1; path=/`;
    expect(isPreviewRequested()).toBe(false);
    document.cookie = `not_${PREVIEW_COOKIE}=1; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  });
});

describe("getRunningChannel", () => {
  test("reports preview for a preview build", () => {
    env.VITE_CHANNEL = "preview";
    env.VITE_APP_VERSION = "abc1234";
    expect(getRunningChannel()).toEqual({
      channel: "preview",
      version: "abc1234",
    });
  });

  test("reports stable when the channel is unset", () => {
    expect(getRunningChannel().channel).toBe("stable");
  });

  test("reports stable for any other channel value", () => {
    env.VITE_CHANNEL = "stable";
    expect(getRunningChannel().channel).toBe("stable");
  });

  test("reports a null version when no version is baked in", () => {
    expect(getRunningChannel().version).toBeNull();
  });
});
