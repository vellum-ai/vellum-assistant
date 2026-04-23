import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { MeetServiceSchema } from "./config-schema.js";
import type { MeetService } from "./config-schema.js";

/**
 * Path to the meet-specific config file relative to the workspace root.
 * The file is expected at `<workspaceDir>/config/meet.json`.
 */
const MEET_CONFIG_RELATIVE = "config/meet.json";

/**
 * Read and validate the meet config from
 * `<workspaceDir>/config/meet.json`. When the file is missing or
 * unparseable, schema defaults are returned so the skill always has a
 * valid config object. This decouples the meet skill's configuration
 * from the assistant's global `config.json` → `services.meet` path.
 *
 * Callers pass the workspace directory they obtained from the host
 * (`host.platform.workspaceDir()`) or, in the session manager, from
 * `deps.getWorkspaceDir()`. Keeping the path input explicit avoids any
 * dependency from this file into `assistant/src/util/platform.js`.
 */
export function getMeetConfig(workspaceDir: string): MeetService {
  const configPath = join(workspaceDir, MEET_CONFIG_RELATIVE);

  if (!existsSync(configPath)) {
    return MeetServiceSchema.parse({});
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return MeetServiceSchema.parse({});
  }

  const result = MeetServiceSchema.safeParse(raw);
  if (result.success) {
    return result.data;
  }

  // Invalid fields — fall back to defaults rather than crashing the skill.
  return MeetServiceSchema.parse({});
}
