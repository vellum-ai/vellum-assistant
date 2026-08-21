/**
 * The invariants this feature rests on: an icon is only ever *offered* for a
 * character avatar the installed build ships a bundle for, `setAppIcon` is only
 * ever reached from a user-pressed callback, and every mounted consumer reads
 * the same shell snapshot.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

import type { AppIconState } from "@/runtime/app-icon";
import type { AvatarState } from "@/types/avatar";

const TRAITS = {
  bodyShape: "blob",
  eyeStyle: "curious",
  color: "cosmic-purple",
};
const ICON = "avatar-blob-curious-cosmic-purple";

const CHARACTER: AvatarState = {
  kind: "character",
  traits: TRAITS,
  source: "builder",
  image: null,
};

/** A custom image whose traits sidecar was never cleaned up. */
const IMAGE_WITH_STALE_TRAITS: AvatarState = {
  kind: "image",
  traits: TRAITS,
  source: "upload",
  image: null,
};

const NONE: AvatarState = {
  kind: "none",
  traits: null,
  source: null,
  image: null,
};

let avatarState: AvatarState | null = CHARACTER;
let nativeIOS = true;
let iconState: AppIconState = {
  supported: true,
  current: null,
  available: [ICON],
};

const getAppIconState = mock(async () => iconState);
const setAppIcon = mock(async (_name: string | null) => true);

mock.module("@/runtime/app-icon", () => ({ getAppIconState, setAppIcon }));
mock.module("@/runtime/platform-detection", () => ({
  useIsNativeIOS: () => nativeIOS,
}));
mock.module("@/hooks/use-assistant-avatar", () => ({
  useAssistantAvatar: () => ({
    components: null,
    traits: avatarState?.traits ?? null,
    customImageUrl: null,
    state: avatarState,
    isLoading: false,
    invalidate: () => {},
  }),
}));

const { useAppIconSync } = await import("@/hooks/use-app-icon-sync");
const { APP_ICON_UNSUPPORTED, useAppIconStore } =
  await import("@/stores/app-icon-store");
const { useClientFeatureFlagStore } =
  await import("@/stores/client-feature-flag-store");
const { publish } = await import("@/lib/event-bus");

async function renderSync() {
  const view = renderHook(() => useAppIconSync("asst-1"));
  await waitFor(() => {
    expect(getAppIconState).toHaveBeenCalled();
  });
  return view;
}

beforeEach(() => {
  avatarState = CHARACTER;
  nativeIOS = true;
  iconState = { supported: true, current: null, available: [ICON] };
  useAppIconStore.setState({ snapshot: APP_ICON_UNSUPPORTED });
  useClientFeatureFlagStore.setState({ iosAvatarAppIcon: true });
});

afterEach(() => {
  cleanup();
  getAppIconState.mockClear();
  setAppIcon.mockClear();
  useClientFeatureFlagStore.setState({ iosAvatarAppIcon: false });
});

describe("useAppIconSync", () => {
  test("offers the bundled icon for a character avatar", async () => {
    const { result } = await renderSync();

    await waitFor(() => {
      expect(result.current.enabled).toBe(true);
    });
    expect(result.current.targetIcon).toBe(ICON);
    expect(result.current.canOffer).toBe(true);
  });

  test("stays off the whole way down off native iOS", async () => {
    nativeIOS = false;

    const { result } = renderHook(() => useAppIconSync("asst-1"));

    expect(result.current.enabled).toBe(false);
    expect(result.current.canOffer).toBe(false);
    expect(result.current.targetIcon).toBeNull();
    expect(getAppIconState).not.toHaveBeenCalled();
  });

  test("stays off with the flag off", async () => {
    useClientFeatureFlagStore.setState({ iosAvatarAppIcon: false });

    const { result } = renderHook(() => useAppIconSync("asst-1"));

    expect(result.current.enabled).toBe(false);
    expect(result.current.canOffer).toBe(false);
    expect(getAppIconState).not.toHaveBeenCalled();
  });

  test("stays off on a shell that ships no alternate icons", async () => {
    iconState = { supported: false, current: null, available: [] };

    const { result } = await renderSync();

    await waitFor(() => {
      expect(getAppIconState).toHaveBeenCalled();
    });
    expect(result.current.enabled).toBe(false);
    expect(result.current.canOffer).toBe(false);
  });

  test("never offers for a custom image, even with stale traits", async () => {
    avatarState = IMAGE_WITH_STALE_TRAITS;

    const { result } = await renderSync();

    await waitFor(() => {
      expect(result.current.enabled).toBe(true);
    });
    expect(result.current.targetIcon).toBeNull();
    expect(result.current.canOffer).toBe(false);
  });

  test("never offers when there is no avatar", async () => {
    avatarState = NONE;

    const { result } = await renderSync();

    await waitFor(() => {
      expect(result.current.enabled).toBe(true);
    });
    expect(result.current.targetIcon).toBeNull();
    expect(result.current.canOffer).toBe(false);
  });

  test("never offers a name this build does not bundle", async () => {
    iconState = { supported: true, current: null, available: ["avatar-other"] };

    const { result } = await renderSync();

    await waitFor(() => {
      expect(result.current.enabled).toBe(true);
    });
    expect(result.current.targetIcon).toBe(ICON);
    expect(result.current.canOffer).toBe(false);
  });

  test("does not offer the icon that is already applied", async () => {
    iconState = { supported: true, current: ICON, available: [ICON] };

    const { result } = await renderSync();

    await waitFor(() => {
      expect(result.current.currentIcon).toBe(ICON);
    });
    expect(result.current.canOffer).toBe(false);
  });

  test("apply swaps to the target and re-reads the shell", async () => {
    const { result } = await renderSync();
    await waitFor(() => {
      expect(result.current.canOffer).toBe(true);
    });
    getAppIconState.mockClear();
    iconState = { supported: true, current: ICON, available: [ICON] };

    await act(async () => {
      await result.current.apply();
    });

    expect(setAppIcon).toHaveBeenCalledTimes(1);
    expect(setAppIcon.mock.calls[0]?.[0]).toBe(ICON);
    expect(getAppIconState).toHaveBeenCalled();
    await waitFor(() => {
      expect(result.current.canOffer).toBe(false);
    });
  });

  test("reset restores the default icon", async () => {
    iconState = { supported: true, current: ICON, available: [ICON] };
    const { result } = await renderSync();
    await waitFor(() => {
      expect(result.current.currentIcon).toBe(ICON);
    });

    await act(async () => {
      await result.current.reset();
    });

    expect(setAppIcon).toHaveBeenCalledTimes(1);
    expect(setAppIcon.mock.calls[0]?.[0]).toBeNull();
  });

  test("apply is inert when nothing is offerable", async () => {
    avatarState = NONE;
    const { result } = await renderSync();
    await waitFor(() => {
      expect(result.current.enabled).toBe(true);
    });

    await act(async () => {
      await result.current.apply();
    });

    expect(setAppIcon).not.toHaveBeenCalled();
  });

  test("an apply in one consumer reaches every other consumer", async () => {
    // The root prompt and the settings card, both mounted while the user is on
    // the Privacy page.
    const prompt = await renderSync();
    const card = renderHook(() => useAppIconSync("asst-1"));
    await waitFor(() => {
      expect(card.result.current.canOffer).toBe(true);
    });
    iconState = { supported: true, current: ICON, available: [ICON] };

    await act(async () => {
      await prompt.result.current.apply();
    });

    await waitFor(() => {
      expect(card.result.current.currentIcon).toBe(ICON);
    });
    // The card must stop offering an icon that is already on the home screen,
    // rather than firing a second iOS swap alert for it.
    expect(card.result.current.canOffer).toBe(false);
  });

  test("a reset in one consumer reaches every other consumer", async () => {
    iconState = { supported: true, current: ICON, available: [ICON] };
    const card = await renderSync();
    const prompt = renderHook(() => useAppIconSync("asst-1"));
    await waitFor(() => {
      expect(prompt.result.current.currentIcon).toBe(ICON);
    });
    iconState = { supported: true, current: null, available: [ICON] };

    await act(async () => {
      await card.result.current.reset();
    });

    await waitFor(() => {
      expect(prompt.result.current.currentIcon).toBeNull();
    });
  });

  test("re-reads the shell's answer on foreground", async () => {
    const { result } = await renderSync();
    await waitFor(() => {
      expect(result.current.canOffer).toBe(true);
    });
    // The user put the default icon back from iOS Settings while the app was
    // in the background.
    iconState = { supported: true, current: ICON, available: [ICON] };

    await act(async () => {
      publish("app.resume", { signal: "app_state" });
    });

    await waitFor(() => {
      expect(result.current.currentIcon).toBe(ICON);
    });
    expect(result.current.canOffer).toBe(false);
  });
});

describe("setAppIcon call sites", () => {
  test("only the sync hook's two callbacks reach the shell", () => {
    const srcRoot = join(import.meta.dir, "..");
    const counts: string[] = [];

    for (const entry of readdirSync(srcRoot, { recursive: true })) {
      const relative = String(entry);
      if (!/\.tsx?$/.test(relative)) {
        continue;
      }
      if (/\.(test|stories)\.tsx?$/.test(relative)) {
        continue;
      }
      // The wrapper that defines it.
      if (relative === join("runtime", "app-icon.ts")) {
        continue;
      }
      const source = readFileSync(join(srcRoot, relative), "utf8");
      const calls = source.split("setAppIcon(").length - 1;
      if (calls > 0) {
        counts.push(`${relative}:${calls}`);
      }
    }

    expect(counts).toEqual([`${join("hooks", "use-app-icon-sync.ts")}:2`]);
  });
});
