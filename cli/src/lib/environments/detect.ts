import { readdirSync } from "fs";

import { SEEDS, type EnvironmentDefinition } from "@vellumai/environments";

import { getMultiInstanceDir } from "./paths.js";
import { getCurrentEnvironment } from "./resolve.js";

/**
 * Names of OTHER environments (every seed except `currentEnv`) whose
 * multi-instance data dir exists and holds at least one assistant
 * subdirectory.
 *
 * Each environment has its own on-host data layout — see
 * {@link getMultiInstanceDir}. A user who hatched via a dev/staging desktop
 * app but runs the production npm CLI (or vice versa) targets a different
 * layout than the app did, so the assistant the app created is invisible to
 * this CLI. This cheap filesystem scan surfaces that split so callers can
 * point the user at the environment that actually holds their assistants.
 *
 * Never throws: a missing or unreadable dir just means that environment has no
 * discoverable assistants, so it is skipped. Returns an empty array on any
 * error.
 */
export function detectOtherEnvironmentAssistants(
  currentEnv: EnvironmentDefinition,
): string[] {
  const found: string[] = [];
  for (const env of Object.values(SEEDS)) {
    if (env.name === currentEnv.name) {
      continue;
    }
    try {
      const hasAssistant = readdirSync(getMultiInstanceDir(env), {
        withFileTypes: true,
      }).some((dirent) => dirent.isDirectory());
      if (hasAssistant) {
        found.push(env.name);
      }
    } catch {
      // Missing or unreadable dir — this environment has no discoverable
      // assistants. Skip it.
    }
  }
  return found;
}

/**
 * One-line hint appended to "no assistant found" and "gateway unreachable"
 * errors when another environment's data dir holds assistants. A first-time
 * user who hatched via a dev/staging desktop app while running the production
 * npm CLI otherwise gets a bare failure with no clue the two tools target
 * different environments.
 *
 * Returns null when nothing is found so callers can append unconditionally:
 * `message + (crossEnvironmentAssistantHint() ?? "")`. Detection failure never
 * propagates — the caller's original error must survive intact.
 */
export function crossEnvironmentAssistantHint(): string | null {
  let currentEnv: EnvironmentDefinition;
  let others: string[];
  try {
    currentEnv = getCurrentEnvironment();
    others = detectOtherEnvironmentAssistants(currentEnv);
  } catch {
    return null;
  }
  if (others.length === 0) {
    return null;
  }

  const quoted = others.map((name) => `'${name}'`).join(", ");
  const noun = others.length > 1 ? "environments" : "environment";
  return (
    `\n\nFound assistants in the ${quoted} ${noun} (managed by a dev/staging ` +
    `desktop app). This CLI targets '${currentEnv.name}'. Use the desktop ` +
    `app's 'Install vellum Command…' menu item to get a matching CLI, or ` +
    `set VELLUM_ENVIRONMENT=${others[0]}.`
  );
}
