/**
 * Schedule risk classifier — escalates schedule_create / schedule_update to
 * High when the schedule runs in `script` mode.
 *
 * Background:
 * `script` mode (PR #27252, ATL-215) executes a raw shell command directly
 * via `Bun.spawn(["sh", "-c", command])` in `schedule/run-script.ts` without
 * going through the bash risk classifier or command registry. Tools
 * `schedule_create` / `schedule_update` are `medium` risk by default, which
 * means background guardian sessions (scheduled scans, periodic digests,
 * heartbeats) auto-approve them. A prompt-injection payload flowing into
 * such a session could therefore land a script-mode schedule that, once it
 * fires, runs arbitrary shell on the host.
 *
 * Classification:
 *  - `mode === "script"` (explicit script mode request)        → High
 *  - `script` field provided with a non-empty value            → High
 *  - otherwise (notify / execute / unspecified)                → Medium
 *
 * See ATL-218 for the full threat model and Codex finding 2f90085c.
 */

import type { RiskAssessment, RiskClassifier } from "./risk-types.js";

// ── Input type ───────────────────────────────────────────────────────────────

/** Input to the schedule risk classifier. */
export interface ScheduleClassifierInput {
  /** Which schedule tool is being invoked. */
  toolName: "schedule_create" | "schedule_update";
  /** The requested schedule mode, if provided. */
  mode?: string;
  /** The shell command to run, if provided (used by mode=script). */
  script?: string;
}

// ── Classifier ───────────────────────────────────────────────────────────────

const SCRIPT_MODE_REASON =
  "Schedule in script mode runs an arbitrary shell command on the host " +
  "without going through the bash permission classifier";

/**
 * Schedule risk classifier implementation.
 *
 * Only `schedule_create` and `schedule_update` route through here. Other
 * schedule tools (`schedule_list`, `schedule_delete`) keep their static
 * registry risk (low / high respectively).
 */
export class ScheduleRiskClassifier
  implements RiskClassifier<ScheduleClassifierInput>
{
  async classify(input: ScheduleClassifierInput): Promise<RiskAssessment> {
    const { toolName, mode, script } = input;

    const hasScriptContent =
      typeof script === "string" && script.trim().length > 0;
    const involvesScriptMode = mode === "script" || hasScriptContent;

    if (involvesScriptMode) {
      return {
        riskLevel: "high",
        reason: SCRIPT_MODE_REASON,
        scopeOptions: [],
        matchType: "registry",
      };
    }

    // Non-script schedules keep their registry default (medium). Returning
    // medium here preserves existing behaviour for notify/execute modes
    // and keeps trust-rule auto-allow ergonomic for routine automations.
    return {
      riskLevel: "medium",
      reason:
        toolName === "schedule_create"
          ? "Schedule create (notify/execute)"
          : "Schedule update (notify/execute)",
      scopeOptions: [],
      matchType: "registry",
    };
  }
}

/** Singleton classifier instance. */
export const scheduleRiskClassifier = new ScheduleRiskClassifier();
