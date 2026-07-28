import { describe, expect, test } from "bun:test";

import { SUBAGENT_ROLE_REGISTRY } from "../subagent/index.js";
import { findUnknownAllowlistTools } from "../subagent/validate-allowlists.js";

/** Union of every tool name referenced by any role allowlist. */
function allReferencedToolNames(): Set<string> {
  const names = new Set<string>();
  for (const config of Object.values(SUBAGENT_ROLE_REGISTRY)) {
    for (const tool of config.allowedTools ?? []) names.add(tool);
  }
  return names;
}

describe("findUnknownAllowlistTools", () => {
  test("returns [] when every referenced tool name is registered", () => {
    // A registered-name set that covers every allowlist entry yields no
    // unknowns — a fully-resolvable registry is a silent no-op.
    expect(findUnknownAllowlistTools(allReferencedToolNames())).toEqual([]);
  });

  test("flags an allowlist entry whose tool name is not registered", () => {
    // Simulate a tool rename that left the allowlists stale: drop one real
    // name from the registered set and confirm exactly the roles that list it
    // are flagged — and nothing else.
    const registered = allReferencedToolNames();
    registered.delete("web_search");

    const unknown = findUnknownAllowlistTools(registered);
    expect(unknown.length).toBeGreaterThan(0);
    expect(unknown.every((u) => u.tool === "web_search")).toBe(true);

    const flaggedRoles = unknown.map((u) => u.role).sort();
    const expectedRoles = Object.entries(SUBAGENT_ROLE_REGISTRY)
      .filter(([, config]) => config.allowedTools?.includes("web_search"))
      .map(([role]) => role)
      .sort();
    expect(flaggedRoles).toEqual(expectedRoles);
  });

  test("skips roles with no allowlist (general imposes no filter)", () => {
    // `general` has allowedTools: undefined, so even against an empty registry
    // it contributes no entries.
    const unknown = findUnknownAllowlistTools(new Set());
    expect(unknown.some((u) => u.role === "general")).toBe(false);
  });
});
