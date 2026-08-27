/**
 * The invariants this feature rests on: only a name the installed build ships a
 * bundle for can be applied, `setAppIcon` is only ever reached from a
 * user-pressed callback, every mounted consumer reads the same shell snapshot,
 * and a swap counts as landed only when a re-read of the shell says the home
 * screen holds the icon that was asked for.
 *
 * The avatar-derived name is a separate fact from what can be applied: it gates
 * the one-tap sync shortcut only, so a user with no character avatar can still
 * choose an icon by hand.
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
const ICON = "avatar-eyes-curious-cosmic-purple";
/** A second bundled icon, the one no avatar here maps to. */
const OTHER = "avatar-eyes-goofy-teal";

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

/** What the shell answers the next swap with: iOS is free to refuse one. */
let swapSucceeds = true;

// The two are deliberately independent: what the shell answers a swap with and
// what it reports afterwards are separate facts, so a test models a swap that
// landed by moving `iconState` and a swap that silently did not by leaving it
// where it was.
const getAppIconState = mock(async () => iconState);
const setAppIcon = mock(async (_name: string | null) => swapSucceeds);

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
  swapSucceeds = true;
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
  test("reports a syncable icon for a character avatar", async () => {
    const { result } = await renderSync();

    await waitFor(() => {
      expect(result.current.enabled).toBe(true);
    });
    expect(result.current.targetIcon).toBe(ICON);
    expect(result.current.canSyncAvatar).toBe(true);
  });

  test("stays off the whole way down off native iOS", async () => {
    nativeIOS = false;

    const { result } = renderHook(() => useAppIconSync("asst-1"));

    expect(result.current.enabled).toBe(false);
    expect(result.current.canSyncAvatar).toBe(false);
    expect(result.current.targetIcon).toBeNull();
    expect(getAppIconState).not.toHaveBeenCalled();
  });

  test("stays off with the flag off", async () => {
    useClientFeatureFlagStore.setState({ iosAvatarAppIcon: false });

    const { result } = renderHook(() => useAppIconSync("asst-1"));

    expect(result.current.enabled).toBe(false);
    expect(result.current.canSyncAvatar).toBe(false);
    expect(getAppIconState).not.toHaveBeenCalled();
  });

  test("stays off on a shell that ships no alternate icons", async () => {
    iconState = { supported: false, current: null, available: [] };

    const { result } = await renderSync();

    await waitFor(() => {
      expect(getAppIconState).toHaveBeenCalled();
    });
    expect(result.current.enabled).toBe(false);
    expect(result.current.canSyncAvatar).toBe(false);
  });

  test("never syncs for a custom image, even with stale traits", async () => {
    avatarState = IMAGE_WITH_STALE_TRAITS;

    const { result } = await renderSync();

    await waitFor(() => {
      expect(result.current.enabled).toBe(true);
    });
    expect(result.current.targetIcon).toBeNull();
    expect(result.current.canSyncAvatar).toBe(false);
  });

  test("never syncs when there is no avatar", async () => {
    avatarState = NONE;

    const { result } = await renderSync();

    await waitFor(() => {
      expect(result.current.enabled).toBe(true);
    });
    expect(result.current.targetIcon).toBeNull();
    expect(result.current.canSyncAvatar).toBe(false);
  });

  test("never syncs to a name this build does not bundle", async () => {
    iconState = { supported: true, current: null, available: ["avatar-other"] };

    const { result } = await renderSync();

    await waitFor(() => {
      expect(result.current.enabled).toBe(true);
    });
    expect(result.current.targetIcon).toBe(ICON);
    expect(result.current.canSyncAvatar).toBe(false);
  });

  test("does not sync to the icon that is already applied", async () => {
    iconState = { supported: true, current: ICON, available: [ICON] };

    const { result } = await renderSync();

    await waitFor(() => {
      expect(result.current.currentIcon).toBe(ICON);
    });
    expect(result.current.canSyncAvatar).toBe(false);
  });

  test("apply swaps to the target and re-reads the shell", async () => {
    const { result } = await renderSync();
    await waitFor(() => {
      expect(result.current.canSyncAvatar).toBe(true);
    });
    getAppIconState.mockClear();
    iconState = { supported: true, current: ICON, available: [ICON] };

    let applied: boolean | undefined;
    await act(async () => {
      applied = await result.current.apply(ICON);
    });

    expect(applied).toBe(true);
    expect(setAppIcon).toHaveBeenCalledTimes(1);
    expect(setAppIcon.mock.calls[0]?.[0]).toBe(ICON);
    expect(getAppIconState).toHaveBeenCalled();
    await waitFor(() => {
      expect(result.current.canSyncAvatar).toBe(false);
    });
  });

  test("apply reports a swap the shell took but never made", async () => {
    // iOS accepting `setAlternateIconName` and leaving the home screen alone:
    // the request says it worked and the next read says otherwise.
    const { result } = await renderSync();
    await waitFor(() => {
      expect(result.current.canSyncAvatar).toBe(true);
    });

    let applied: boolean | undefined;
    await act(async () => {
      applied = await result.current.apply(ICON);
    });

    expect(setAppIcon).toHaveBeenCalledTimes(1);
    // The read is what counts, and it still reports the default icon.
    expect(applied).toBe(false);
    expect(useAppIconStore.getState().snapshot.current).toBeNull();
    expect(result.current.currentIcon).toBeNull();
    expect(result.current.canSyncAvatar).toBe(true);
  });

  test("apply reports failure when the re-read degrades", async () => {
    const { result } = await renderSync();
    await waitFor(() => {
      expect(result.current.canSyncAvatar).toBe(true);
    });
    // The shell stops answering mid-swap, which every degrade path in
    // `runtime/app-icon` turns into this snapshot rather than a rejection.
    iconState = { supported: false, current: null, available: [] };

    let applied: boolean | undefined;
    await act(async () => {
      applied = await result.current.apply(ICON);
    });

    expect(applied).toBe(false);
    expect(useAppIconStore.getState().snapshot).toEqual(APP_ICON_UNSUPPORTED);
    await waitFor(() => {
      expect(result.current.enabled).toBe(false);
    });
  });

  test("reset restores the default icon", async () => {
    iconState = { supported: true, current: ICON, available: [ICON] };
    const { result } = await renderSync();
    await waitFor(() => {
      expect(result.current.currentIcon).toBe(ICON);
    });
    iconState = { supported: true, current: null, available: [ICON] };

    let restored: boolean | undefined;
    await act(async () => {
      restored = await result.current.reset();
    });

    expect(restored).toBe(true);
    expect(setAppIcon).toHaveBeenCalledTimes(1);
    expect(setAppIcon.mock.calls[0]?.[0]).toBeNull();
    await waitFor(() => {
      expect(result.current.currentIcon).toBeNull();
    });
  });

  test("reset reports failure when the re-read degrades", async () => {
    iconState = { supported: true, current: ICON, available: [ICON] };
    const { result } = await renderSync();
    await waitFor(() => {
      expect(result.current.currentIcon).toBe(ICON);
    });
    iconState = { supported: false, current: null, available: [] };

    let restored: boolean | undefined;
    await act(async () => {
      restored = await result.current.reset();
    });

    expect(restored).toBe(false);
    expect(useAppIconStore.getState().snapshot).toEqual(APP_ICON_UNSUPPORTED);
    await waitFor(() => {
      expect(result.current.enabled).toBe(false);
    });
  });

  test("reset reports a swap the shell took but never made", async () => {
    iconState = { supported: true, current: ICON, available: [ICON] };
    const { result } = await renderSync();
    await waitFor(() => {
      expect(result.current.currentIcon).toBe(ICON);
    });

    let restored: boolean | undefined;
    await act(async () => {
      restored = await result.current.reset();
    });

    expect(setAppIcon).toHaveBeenCalledTimes(1);
    expect(restored).toBe(false);
    expect(useAppIconStore.getState().snapshot.current).toBe(ICON);
    expect(result.current.currentIcon).toBe(ICON);
  });

  test("apply hands back a refusal and leaves the snapshot truthful", async () => {
    swapSucceeds = false;
    const { result } = await renderSync();
    await waitFor(() => {
      expect(result.current.canSyncAvatar).toBe(true);
    });
    getAppIconState.mockClear();

    let applied: boolean | undefined;
    await act(async () => {
      applied = await result.current.apply(ICON);
    });

    expect(applied).toBe(false);
    // Nothing changed on the home screen, so the shell is re-read anyway and
    // the sync shortcut is still standing.
    expect(getAppIconState).toHaveBeenCalled();
    expect(result.current.currentIcon).toBeNull();
    expect(result.current.canSyncAvatar).toBe(true);
  });

  test("reset hands back a refusal and leaves the icon applied", async () => {
    swapSucceeds = false;
    iconState = { supported: true, current: ICON, available: [ICON] };
    const { result } = await renderSync();
    await waitFor(() => {
      expect(result.current.currentIcon).toBe(ICON);
    });

    let restored: boolean | undefined;
    await act(async () => {
      restored = await result.current.reset();
    });

    expect(restored).toBe(false);
    expect(result.current.currentIcon).toBe(ICON);
  });

  test("applies any bundled name, whatever the avatar is", async () => {
    // The picker lets a custom-image user choose an icon by hand. The avatar
    // maps to none, which gates the one-tap sync but not a deliberate choice.
    avatarState = IMAGE_WITH_STALE_TRAITS;
    iconState = { supported: true, current: null, available: [ICON, OTHER] };
    const { result } = await renderSync();
    await waitFor(() => {
      expect(result.current.enabled).toBe(true);
    });
    expect(result.current.canSyncAvatar).toBe(false);
    iconState = { supported: true, current: OTHER, available: [ICON, OTHER] };

    let applied: boolean | undefined;
    await act(async () => {
      applied = await result.current.apply(OTHER);
    });

    expect(applied).toBe(true);
    expect(setAppIcon).toHaveBeenCalledTimes(1);
    expect(setAppIcon.mock.calls[0]?.[0]).toBe(OTHER);
    await waitFor(() => {
      expect(result.current.currentIcon).toBe(OTHER);
    });
  });

  test("refuses a name the installed shell does not bundle", async () => {
    // Version skew: a web build that knows a trait pair the installed binary
    // has no bundle for. Nothing reaches the shell, so nothing can error.
    const { result } = await renderSync();
    await waitFor(() => {
      expect(result.current.enabled).toBe(true);
    });

    let applied: boolean | undefined;
    await act(async () => {
      applied = await result.current.apply(OTHER);
    });

    expect(applied).toBe(false);
    expect(setAppIcon).not.toHaveBeenCalled();
  });

  test("refuses to apply while the surface is disabled", async () => {
    useClientFeatureFlagStore.setState({ iosAvatarAppIcon: false });
    const { result } = renderHook(() => useAppIconSync("asst-1"));

    let applied: boolean | undefined;
    await act(async () => {
      applied = await result.current.apply(ICON);
    });

    expect(applied).toBe(false);
    expect(setAppIcon).not.toHaveBeenCalled();
  });

  test("reports the shell's bundled names", async () => {
    iconState = { supported: true, current: null, available: [ICON, OTHER] };

    const { result } = await renderSync();

    await waitFor(() => {
      expect(result.current.availableIcons).toEqual([ICON, OTHER]);
    });
  });

  test("reports no bundled names while the surface is disabled", async () => {
    nativeIOS = false;

    const { result } = renderHook(() => useAppIconSync("asst-1"));

    expect(result.current.availableIcons).toEqual([]);
  });

  test("an apply in one consumer reaches every other consumer", async () => {
    // The picker modal and the settings row behind it, both mounted at once.
    const modal = await renderSync();
    const row = renderHook(() => useAppIconSync("asst-1"));
    await waitFor(() => {
      expect(row.result.current.canSyncAvatar).toBe(true);
    });
    iconState = { supported: true, current: ICON, available: [ICON] };

    await act(async () => {
      await modal.result.current.apply(ICON);
    });

    await waitFor(() => {
      expect(row.result.current.currentIcon).toBe(ICON);
    });
    // The row must stop offering an icon that is already on the home screen,
    // rather than firing a second iOS swap alert for it.
    expect(row.result.current.canSyncAvatar).toBe(false);
  });

  test("a reset in one consumer reaches every other consumer", async () => {
    iconState = { supported: true, current: ICON, available: [ICON] };
    const modal = await renderSync();
    const row = renderHook(() => useAppIconSync("asst-1"));
    await waitFor(() => {
      expect(row.result.current.currentIcon).toBe(ICON);
    });
    iconState = { supported: true, current: null, available: [ICON] };

    await act(async () => {
      await modal.result.current.reset();
    });

    await waitFor(() => {
      expect(row.result.current.currentIcon).toBeNull();
    });
  });

  test("re-reads the shell's answer on foreground", async () => {
    const { result } = await renderSync();
    await waitFor(() => {
      expect(result.current.canSyncAvatar).toBe(true);
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
    expect(result.current.canSyncAvatar).toBe(false);
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
      // The wrapper that defines it, which naturally names it once.
      if (relative === join("runtime", "app-icon.ts")) {
        continue;
      }
      const source = readFileSync(join(srcRoot, relative), "utf8");
      // Doc comments discuss the wrapper by name, so only call expressions in
      // real code count toward the budget.
      const code = source
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
        .join("\n");
      const calls = code.split(/\bsetAppIcon\s*\(/).length - 1;
      if (calls > 0) {
        counts.push(`${relative}:${calls}`);
      }
    }

    expect(counts).toEqual([`${join("hooks", "use-app-icon-sync.ts")}:2`]);
  });
});
