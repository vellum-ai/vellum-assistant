/**
 * Guard: every route in the shared `ROUTES` table declares an explicit
 * `tags` array.
 *
 * The OpenAPI generator (`scripts/generate-openapi.ts`) builds the spec by
 * importing this assembled table and reads each operation's tag straight from
 * `RouteDefinition.tags` — it no longer derives a fallback tag from the source
 * filename. A route that omits `tags` would therefore land in the spec (and the
 * generated client SDK) untagged, silently losing its grouping. Requiring an
 * explicit tag keeps that contract enforced at the source rather than in the
 * generator.
 */

import { describe, expect, test } from "bun:test";

import { ROUTES } from "../index.js";

describe("shared route table tags", () => {
  test("every route declares a non-empty tags array", () => {
    const untagged = ROUTES.filter(
      (r) => !Array.isArray(r.tags) || r.tags.length === 0,
    ).map((r) => `${r.method} ${r.endpoint} (${r.operationId})`);

    expect(untagged).toEqual([]);
  });
});
