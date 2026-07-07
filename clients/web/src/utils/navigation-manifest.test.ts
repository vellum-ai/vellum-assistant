import { describe, expect, test } from "bun:test";

import {
  buildManifest,
  missingRouteKeys,
  staleDescriptionKeys,
  type NavigationManifest,
} from "../../scripts/generate-navigation-manifest";
import committedJson from "../navigation-manifest.json";

const committed = committedJson as NavigationManifest;

describe("navigation manifest", () => {
  test("every route key is described or marked internal", () => {
    // New route? Add it to PAGE_DESCRIPTIONS (user-facing) or
    // INTERNAL_ROUTE_KEYS (not a doctor-referable page) in page-descriptions.ts.
    expect(missingRouteKeys()).toEqual([]);
  });

  test("no described or internal keys point at removed routes", () => {
    expect(staleDescriptionKeys()).toEqual([]);
  });

  test("committed navigation-manifest.json is up to date — if this fails run `bun run generate:nav-manifest` and commit the result", () => {
    expect(committed).toEqual(buildManifest());
  });
});
