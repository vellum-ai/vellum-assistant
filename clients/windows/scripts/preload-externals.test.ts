import { expect, test } from "bun:test";
import path from "node:path";

import {
  ALLOWED_PRELOAD_EXTERNALS,
  buildPreloadAndScanExternals,
} from "../../../packages/electron-desktop/src/preload-externals";

// Regression guard: a dependency reachable from the preload but missing from
// DEPS_TO_INLINE becomes a bare require() the sandboxed preload can't
// resolve, silently killing the whole window.vellum bridge.
test("built preload bundle externalizes only sandbox-safe modules", async () => {
  const externals = await buildPreloadAndScanExternals(
    path.join(import.meta.dir, ".."),
  );
  expect(externals).toEqual(ALLOWED_PRELOAD_EXTERNALS);
}, 180_000);
