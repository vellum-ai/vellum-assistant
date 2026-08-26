import type { AppSummary } from "@/types/app-types";

/**
 * An {@link AppSummary} with the server-derived fields filled in, so a test
 * naming only what it cares about (usually an id, a name, and a pin) still
 * hands its subject a well-formed app.
 */
export function makeAppSummary(
  overrides: Partial<AppSummary> & { id: string },
): AppSummary {
  return {
    name: `App ${overrides.id}`,
    createdAt: 0,
    updatedAt: 0,
    version: "1",
    contentId: `content-${overrides.id}`,
    origin: "workspace",
    ...overrides,
  };
}
