import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { getAllDefaultPlugins } from "../plugins/defaults/index.js";
import { getWorkspacePluginsDir } from "../util/platform.js";
import {
  getEffectiveEnabledPluginSet,
  resolveTurnActorPrincipalId,
} from "./conversation-tool-setup.js";
import type { TrustContext } from "./trust-context-types.js";

const DEFAULT_NAMES = getAllDefaultPlugins().map((p) => p.manifest.name);

/** Write a `.disabled` sentinel for `pluginName`; returns the created dir. */
function disablePlugin(pluginName: string): string {
  const dir = join(getWorkspacePluginsDir(), pluginName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".disabled"), "");
  return dir;
}

describe("getEffectiveEnabledPluginSet", () => {
  test("returns null when enabledPlugins is null (no per-chat restriction)", () => {
    expect(getEffectiveEnabledPluginSet({ enabledPlugins: null })).toBeNull();
  });

  test("returns null when enabledPlugins is undefined", () => {
    expect(getEffectiveEnabledPluginSet({})).toBeNull();
  });

  test("unions first-party defaults with the selected user plugins", () => {
    const set = getEffectiveEnabledPluginSet({ enabledPlugins: ["user-a"] });
    expect(set).not.toBeNull();
    // The explicitly selected user plugin is present...
    expect(set?.has("user-a")).toBe(true);
    // ...alongside core default-plugin infrastructure, which the new-chat pills
    // never list and so must never be filtered out.
    expect(set?.has("default-memory")).toBe(true);
    expect(set?.has("default-turn-context")).toBe(true);
    expect(set?.has("default-workspace")).toBe(true);
    expect(set?.has("default-session")).toBe(true);
    expect(set?.has("default-title-generate")).toBe(true);
    for (const name of DEFAULT_NAMES) {
      expect(set?.has(name)).toBe(true);
    }
  });

  test("still excludes a non-selected user plugin", () => {
    const set = getEffectiveEnabledPluginSet({ enabledPlugins: ["user-a"] });
    expect(set?.has("user-b")).toBe(false);
  });

  test("an explicit empty scope still includes the defaults", () => {
    const set = getEffectiveEnabledPluginSet({ enabledPlugins: [] });
    expect(set).not.toBeNull();
    expect(set?.has("default-memory")).toBe(true);
    expect(set?.size).toBe(DEFAULT_NAMES.length);
  });

  describe("workspace-disabled plugins (precedence)", () => {
    const created: string[] = [];
    afterEach(() => {
      for (const dir of created.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("drops a workspace-disabled default the conversation did not select", () => {
      created.push(disablePlugin("default-memory"));
      const set = getEffectiveEnabledPluginSet({ enabledPlugins: ["user-a"] });
      expect(set?.has("user-a")).toBe(true);
      // The workspace-disabled default is excluded (rule 2 beats rule 3)...
      expect(set?.has("default-memory")).toBe(false);
      // ...while the other defaults remain.
      expect(set?.has("default-turn-context")).toBe(true);
      expect(set?.size).toBe(DEFAULT_NAMES.length); // user-a + defaults - memory
    });

    test("keeps a conversation-enabled plugin even if workspace-disabled", () => {
      // Rule 1 (per-conversation explicit enable) beats rule 2 (workspace).
      created.push(disablePlugin("user-a"));
      const set = getEffectiveEnabledPluginSet({
        enabledPlugins: ["user-a", "user-b"],
      });
      expect(set?.has("user-a")).toBe(true);
      expect(set?.has("user-b")).toBe(true);
    });

    test("keeps a default the conversation explicitly enabled even if workspace-disabled", () => {
      // Rule 1 beats rule 2 for defaults too.
      created.push(disablePlugin("default-memory"));
      const set = getEffectiveEnabledPluginSet({
        enabledPlugins: ["default-memory"],
      });
      expect(set?.has("default-memory")).toBe(true);
    });
  });
});

describe("resolveTurnActorPrincipalId", () => {
  // The principal this returns is what host proxies compare against the
  // principal a desktop client registered with. Reading the trust context's
  // guardian principal instead made every turn whose trust resolution
  // degraded look like a cross-user attempt.
  const guardianTrust: Pick<TrustContext, "guardianPrincipalId"> = {
    guardianPrincipalId: "guardian-1",
  };
  const noGuardianTrust: Pick<TrustContext, "guardianPrincipalId"> = {};

  test("prefers the turn's actor principal", () => {
    expect(
      resolveTurnActorPrincipalId(
        {
          currentTurnSourceActorPrincipalId: "actor-1",
          currentTurnAuthContext: {
            actorPrincipalId: "actor-2",
          } as never,
        },
        guardianTrust,
      ),
    ).toBe("actor-1");
  });

  test("falls back through the turn and resting auth contexts", () => {
    expect(
      resolveTurnActorPrincipalId(
        { currentTurnAuthContext: { actorPrincipalId: "actor-2" } as never },
        guardianTrust,
      ),
    ).toBe("actor-2");
    expect(
      resolveTurnActorPrincipalId(
        { authContext: { actorPrincipalId: "actor-3" } as never },
        guardianTrust,
      ),
    ).toBe("actor-3");
  });

  test("keeps the guardian principal as the last fallback", () => {
    // Channel turns carry a channel identity as the actor and the guardian
    // principal is what the desktop registered with, so they must keep
    // resolving through the trust context.
    expect(resolveTurnActorPrincipalId({}, guardianTrust)).toBe("guardian-1");
  });

  test("returns the actor even when trust resolved without a guardian principal", () => {
    // The regression: a service-principal turn (bare guardian trust, no
    // principal) or degraded trust resolution used to submit no principal at
    // all, so the same-actor gate rejected on missing_source and host_bash
    // reported an actor mismatch on a single-user desktop.
    expect(
      resolveTurnActorPrincipalId(
        { currentTurnSourceActorPrincipalId: "actor-1" },
        noGuardianTrust,
      ),
    ).toBe("actor-1");
  });

  test("returns undefined when no identity is known at all", () => {
    expect(resolveTurnActorPrincipalId({}, noGuardianTrust)).toBeUndefined();
  });
});
