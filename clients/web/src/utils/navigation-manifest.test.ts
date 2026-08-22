import { describe, expect, mock, test } from "bun:test";
import { matchRoutes } from "react-router";

import {
  buildManifest,
  missingRouteKeys,
  staleDescriptionKeys,
  type NavigationManifest,
} from "../../scripts/generate-navigation-manifest";
import committedJson from "../navigation-manifest.json";

mock.module("@/generated/gateway/@tanstack/react-query.gen", () => ({
  assistantFeatureFlagsGetOptions: () => ({ queryKey: ["assistant-flags"] }),
  assistantFeatureFlagsGetQueryKey: () => ["assistant-flags"],
}));

const { routeTree } = await import("@/routes");

const committed = committedJson as NavigationManifest;

/**
 * Param segments (`:foo`) of the mounted route chain matching `path`, or null
 * if the path only hits the NotFound catch-all (i.e. isn't a real route).
 */
function mountedParamSegments(path: string): string[] | null {
  const concrete = path.replace(/:[^/]+/g, "placeholder");
  const matches = matchRoutes(routeTree as never, concrete) ?? [];
  const routePaths = matches.map(
    (m) => (m.route as { path?: string }).path ?? "",
  );
  if (matches.length === 0 || routePaths.at(-1) === "*") {
    return null;
  }
  return routePaths
    .flatMap((p) => p.split("/"))
    .filter((seg) => seg.startsWith(":"));
}

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

  test("every manifest path matches a mounted route with the same param names", () => {
    const problems: string[] = [];
    for (const page of committed.pages) {
      const mounted = mountedParamSegments(page.path);
      if (mounted === null) {
        problems.push(`${page.key}: ${page.path} does not match a mounted route`);
        continue;
      }
      const manifestParams = page.path
        .split("/")
        .filter((seg) => seg.startsWith(":"));
      if (mounted.join("/") !== manifestParams.join("/")) {
        problems.push(
          `${page.key}: manifest params [${manifestParams.join(", ")}] differ from mounted route params [${mounted.join(", ")}] — set \`params\` in page-descriptions.ts`,
        );
      }
    }
    expect(problems).toEqual([]);
  });
});
