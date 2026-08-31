/**
 * The store is written by every mounted `useAppIconSync` on every mount and
 * every foreground, so identical answers arrive constantly. It has to treat
 * those as no-ops.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { APP_ICON_UNSUPPORTED, useAppIconStore } from "./app-icon-store";

const ICON = "avatar-blob-curious-cosmic-purple";

beforeEach(() => {
  useAppIconStore.setState({ snapshot: APP_ICON_UNSUPPORTED });
});

describe("useAppIconStore", () => {
  test("starts on the snapshot that draws nothing", () => {
    expect(useAppIconStore.getState().snapshot).toEqual(APP_ICON_UNSUPPORTED);
  });

  test("keeps the reference when the shell repeats itself", () => {
    const { setSnapshot } = useAppIconStore.getState();
    setSnapshot({ supported: true, current: null, available: [ICON] });
    const first = useAppIconStore.getState().snapshot;

    setSnapshot({ supported: true, current: null, available: [ICON] });

    expect(useAppIconStore.getState().snapshot).toBe(first);
  });

  test("takes a snapshot whose applied icon changed", () => {
    const { setSnapshot } = useAppIconStore.getState();
    setSnapshot({ supported: true, current: null, available: [ICON] });

    setSnapshot({ supported: true, current: ICON, available: [ICON] });

    expect(useAppIconStore.getState().snapshot.current).toBe(ICON);
  });

  test("takes a snapshot whose bundle list changed", () => {
    const { setSnapshot } = useAppIconStore.getState();
    setSnapshot({ supported: true, current: null, available: [ICON] });

    setSnapshot({ supported: true, current: null, available: [] });

    expect(useAppIconStore.getState().snapshot.available).toEqual([]);
  });
});
