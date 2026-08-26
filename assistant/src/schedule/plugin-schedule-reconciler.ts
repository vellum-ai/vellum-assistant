/**
 * Level-based reconciler converging plugin `schedules/` declarations into
 * `cron_jobs` rows.
 *
 * Each pass enumerates the installed, enabled plugins, parses their
 * declarations (see `./plugin-schedule-declarations.ts`), and diffs the
 * desired set against the sourced rows in the store: new declarations are
 * inserted, changed ones (by `definition_hash`) updated, and rows whose
 * declaration is gone (or, for a script row, no longer parses) are disarmed
 * in place. The reconciler owns only the definition columns; the engine owns
 * the runtime columns and the user owns `user_enabled` (both enforced in
 * `./schedule-store.ts`). Rows with a null `source_key` are imperative
 * schedules and are never touched.
 *
 * Triggers: daemon startup (`daemon/lifecycle.ts`), plugin-set convergence
 * (`plugins/mtime-cache.ts` after an imperative source reconcile), the plugin
 * enable/disable routes (`runtime/routes/plugins-routes.ts`), and a periodic
 * backstop sweep (`runtime/http-server.ts`) that covers the sentinel writers
 * outside the daemon, notably the CLI's own enable/disable.
 *
 * Rows this pass has not caught up with are still safe to leave armed: the
 * scheduler re-reads the `.disabled` sentinel at fire time and the run-now
 * route re-probes the declaration, so reconcile lag delays bookkeeping rather
 * than letting a disabled plugin execute.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { getDbMigrationReadiness } from "../daemon/daemon-readiness.js";
import { recordSubsystemFailure } from "../home/system-health.js";
import { isPluginDisabled } from "../plugins/disabled-state.js";
import { parsePluginManifest } from "../plugins/external-plugin-loader.js";
import { listInstalledPluginDirs } from "../plugins/installed-plugin-dirs.js";
import { isPluginDirActivated } from "../plugins/mtime-cache.js";
import { getLogger } from "../util/logger.js";
import {
  type DeclarationError,
  parsePluginScheduleDeclarations,
  type ScheduleDeclaration,
} from "./plugin-schedule-declarations.js";
import { isPluginSchedulesEnabled } from "./plugin-schedules-gate.js";
import {
  type DeclaredScheduleDefinition,
  disarmDeclaredSchedule,
  listDeclaredSchedules,
  type ScheduleJob,
  upsertDeclaredSchedule,
} from "./schedule-store.js";

const log = getLogger("plugin-schedule-reconciler");

/** In-flight pass; concurrent triggers await it rather than racing. */
let reconcileInFlight: Promise<void> | null = null;

/**
 * Converge plugin-declared schedules against the current on-disk plugin set.
 *
 * Single-flight: concurrent triggers serialize through the in-flight latch,
 * so two passes never interleave their list/diff/write sequences. Never
 * throws: a failed pass is logged and the next trigger retries from disk.
 * No-ops while DB migrations are unready.
 */
export async function reconcilePluginSchedules(): Promise<void> {
  while (reconcileInFlight !== null) {
    await reconcileInFlight;
  }
  reconcileInFlight = (async () => {
    try {
      await runReconcilePass();
    } catch (err) {
      log.error({ err }, "Plugin schedule reconcile failed");
    }
  })().finally(() => {
    reconcileInFlight = null;
  });
  await reconcileInFlight;
}

interface DesiredEntry {
  pluginName: string;
  declaration: ScheduleDeclaration;
}

interface CollectedDeclarations {
  desired: Map<string, DesiredEntry>;
  errors: DeclarationError[];
  manifestFailures: DeclarationError[];
}

async function runReconcilePass(): Promise<void> {
  // The pass is pure DB reads/writes over cron_jobs; refuse to touch a
  // partially-migrated schema (see assistant/CLAUDE.md, DB migration
  // readiness gating). A skipped pass is retried by the periodic sweep.
  if (!getDbMigrationReadiness().ready) {
    return;
  }

  // The feature flag is a kill switch, not just a launch gate. While it is
  // off nothing is parsed and nothing is emitted, and the desired set is
  // empty, so the disarm branch below turns every declared row off on the next
  // pass. Turning the flag back on re-arms them from their declarations.
  const { desired, errors, manifestFailures }: CollectedDeclarations =
    isPluginSchedulesEnabled()
      ? await collectDesiredDeclarations()
      : { desired: new Map(), errors: [], manifestFailures: [] };

  const existingByKey = new Map<string, ScheduleJob>();
  for (const row of listDeclaredSchedules()) {
    if (row.sourceKey !== null) {
      existingByKey.set(row.sourceKey, row);
    }
  }

  for (const [sourceKey, { declaration }] of desired) {
    try {
      await upsertDeclaredSchedule(sourceKey, toDefinition(declaration));
    } catch (err) {
      log.error(
        { err, sourceKey },
        "Failed to apply declared schedule, skipping",
      );
      continue;
    }
  }

  // A key with a declaration error keeps its last-good row untouched: fail
  // closed means the broken declaration does not load, not that a previously
  // healthy schedule is torn down by its own typo. An execute row can be held
  // that way because it fires the message stored on the row, which is the one
  // that last validated.
  //
  // A script row cannot: it fires its entrypoint by absolute path, so holding
  // it armed through an invalid declaration runs whatever `index.sh` now
  // holds, which is exactly the content that failed to validate. Those rows
  // disarm through the same path as an absent declaration and re-arm on the
  // pass after the declaration parses again. An `ended` recurrence is not a
  // rewrite, so it keeps the last-good handling in both modes.
  const erroredKeys = new Set<string>();
  for (const error of errors) {
    const row = existingByKey.get(error.sourceKey);
    const disarmsScriptRow = error.kind === "invalid" && row?.mode === "script";
    if (!disarmsScriptRow) {
      erroredKeys.add(error.sourceKey);
    }
  }

  // Disarm rows whose declaration is absent from the desired set (plugin
  // uninstalled or disabled, or the schedule file removed), plus the script
  // rows an invalid declaration left out of `erroredKeys` above. Teardown
  // deliberately does not ride plugin shutdown hooks: uninstalling a disabled
  // plugin skips them entirely (`cli/lib/uninstall-plugin.ts`), so
  // directory-absence diffing here is the only reliable reap. The row and its
  // runs are kept so a reinstall re-links by `source_key`.
  //
  // `pausedKeys` collects what this pass actually turned off, which is what
  // the notification below reports. A row the user or the engine had already
  // disabled is left alone, and a failed write leaves the row armed, so
  // neither claims a pause that did not happen.
  const pausedKeys = new Set<string>();
  for (const [sourceKey, row] of existingByKey) {
    if (desired.has(sourceKey) || erroredKeys.has(sourceKey)) {
      continue;
    }
    try {
      if (await disarmDeclaredSchedule(row.id)) {
        pausedKeys.add(sourceKey);
      }
    } catch (err) {
      log.error(
        { err, sourceKey, scheduleId: row.id },
        "Failed to disarm declared schedule, skipping",
      );
    }
  }

  // Manifest failures ride the same emit path as declaration errors but are
  // kept out of `erroredKeys` above: an errored key preserves its last-good
  // row, while a manifest failure must let the disarm loop pause the rows.
  for (const error of [...errors, ...manifestFailures]) {
    if (isCompletedRecurrence(error, existingByKey.get(error.sourceKey))) {
      continue;
    }
    emitDefinitionError(error, pausedKeys.has(error.sourceKey));
  }
}

/**
 * True when an `ended` recurrence is the expected end of a bounded schedule
 * rather than something to tell the user about. Three rows qualify: one the
 * engine latched on its last occurrence, which zeroes `next_run_at` with a
 * run behind it; one the user turned off; and one that shipped disabled and
 * was never armed, which has `next_run_at` zeroed with no run behind it and
 * no user choice recorded. None of them lost a firing the user expected.
 *
 * A row this reconciler disarmed does not qualify, and cannot be mistaken
 * for the never-armed one because it keeps the stale non-zero `next_run_at`
 * it was armed with. `enabled = false` there means the plugin is disabled or
 * its declaration was briefly absent, and once the plugin comes back the
 * ended recurrence is a dead schedule the user has to hear about. An ended
 * declaration whose row is still armed loses firings, and one with no row at
 * all arrives dead; both surface.
 */
function isCompletedRecurrence(
  error: DeclarationError,
  row: ScheduleJob | undefined,
): boolean {
  if (error.kind !== "ended" || row === undefined) {
    return false;
  }
  const engineLatched = row.nextRunAt === 0 && row.lastRunAt != null;
  const insertedDisabled =
    !row.enabled &&
    row.nextRunAt === 0 &&
    row.lastRunAt == null &&
    row.userEnabled == null;
  return engineLatched || row.userEnabled === false || insertedDisabled;
}

/**
 * Enumerate installed plugins ({@link listInstalledPluginDirs}, the same walk
 * as the plugin source collector) and gather their schedule declarations.
 * Identity = the directory basename, mirroring `parsePluginManifest`.
 *
 * Disabled plugins, plugins this daemon has not activated
 * ({@link isPluginDirActivated}), and plugins without a `schedules/` directory
 * are skipped entirely; in particular, only schedule-declaring plugins pay the
 * manifest parse each pass. The activation gate is what keeps a directory
 * dropped into the plugins root out of the desired set: nothing has run its
 * `init`, so its hooks and tools are not live and its schedules must not arm
 * either. It joins the set on the pass after the boot scan or an imperative
 * reconcile brings it up. A schedule-declaring plugin whose manifest fails
 * `parsePluginManifest` (unreadable or schema-invalid `package.json`) also
 * contributes nothing to the desired set: the runtime loader refuses to
 * bring such a plugin up, so its schedules must not stay armed either. Each
 * of its declared schedules comes back in `manifestFailures` so the pause is
 * surfaced with the same visibility as a bad declaration.
 */
async function collectDesiredDeclarations(): Promise<CollectedDeclarations> {
  const desired = new Map<string, DesiredEntry>();
  const errors: DeclarationError[] = [];
  const manifestFailures: DeclarationError[] = [];

  for (const { name, dir } of listInstalledPluginDirs()) {
    if (isPluginDisabled(name)) {
      continue;
    }
    if (!isPluginDirActivated(dir)) {
      continue;
    }
    if (!existsSync(join(dir, "schedules"))) {
      continue;
    }
    const parsed = parsePluginScheduleDeclarations(dir, name);
    if ((await parsePluginManifest(dir, { quiet: true })) === undefined) {
      // The reason states the fault only. Whether a row went off over it is
      // the `paused` field's job, which is derived from the disarm outcome.
      const reason = "the plugin's package.json could not be read or validated";
      for (const declared of [
        ...parsed.declarations.map((d) => ({
          scheduleName: d.name,
          sourceKey: d.sourceKey,
        })),
        ...parsed.errors,
      ]) {
        manifestFailures.push({
          pluginName: name,
          scheduleName: declared.scheduleName,
          sourceKey: declared.sourceKey,
          reason,
          kind: "invalid",
        });
      }
      continue;
    }
    for (const declaration of parsed.declarations) {
      desired.set(declaration.sourceKey, { pluginName: name, declaration });
    }
    errors.push(...parsed.errors);
  }

  return { desired, errors, manifestFailures };
}

function toDefinition(
  declaration: ScheduleDeclaration,
): DeclaredScheduleDefinition {
  const { config } = declaration;
  return {
    name: declaration.name,
    description: config.description ?? undefined,
    syntax: config.syntax,
    expression: config.expression,
    timezone: config.timezone,
    // Script-mode runs ignore the message column (the engine executes
    // `script`); it is non-null in the schema, so store an empty string.
    message: declaration.message ?? "",
    script: declaration.scriptInvocation,
    mode: declaration.mode,
    maxRetries: config.maxRetries ?? undefined,
    retryBackoffMs: config.retryBackoffMs ?? undefined,
    quiet: config.quiet ?? undefined,
    inferenceProfile: config.inferenceProfile,
    timeoutMs: config.timeoutMs,
    enabled: config.enabled,
    definitionHash: declaration.definitionHash,
  };
}

/**
 * UTC day of the last recorded definition error per `sourceKey`.
 *
 * A broken declaration re-surfaces on every 60s pass. The health row counts,
 * so without this a single typo would climb into the hundreds overnight and
 * say nothing more than "1" would. One count per schedule per day.
 */
const definitionErrorRecordedDay = new Map<string, string>();

/** Test-only: forget the per-day definition-error latch. */
export function resetDefinitionErrorEmitGuardForTests(): void {
  definitionErrorRecordedDay.clear();
}

/**
 * Record a malformed declaration (or a manifest failure pausing one) against
 * the plugin-schedules subsystem, with `paused` noted when this pass disarmed
 * the row over it.
 *
 * This is developer-facing: it is a plugin author's problem, not the user's,
 * and there is nothing for the user to do about it from a notification. It
 * belongs in the System health counter, which counts without pushing, rather
 * than in the bell.
 */
function emitDefinitionError(error: DeclarationError, paused: boolean): void {
  const day = new Date().toISOString().slice(0, 10);
  if (definitionErrorRecordedDay.get(error.sourceKey) === day) {
    return;
  }
  definitionErrorRecordedDay.set(error.sourceKey, day);
  void recordSubsystemFailure({
    subsystem: "plugin_schedules",
    label: "Plugin schedules",
    errorSummary: `"${error.scheduleName}" from ${error.pluginName} ${
      paused ? "was paused: " : "could not be read: "
    }${error.reason}`,
  });
}

// ── Periodic backstop sweep ─────────────────────────────────────────────

/**
 * Backstop interval. Enable/disable flows write the `.disabled` sentinel
 * without poking the plugin source reconcile, so this bounds how long a
 * toggle can go unreflected in the rows.
 */
const SWEEP_INTERVAL_MS = 60_000;

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Guard against a slow pass stacking further passes behind the latch. */
let sweepInProgress = false;

/**
 * Start the periodic reconcile sweep. Idempotent: repeat calls reuse the
 * timer. The DB-readiness guard lives inside {@link reconcilePluginSchedules},
 * which no-ops while migrations are unready.
 */
export function startPluginScheduleReconcileSweep(): void {
  if (sweepTimer) {
    return;
  }
  sweepTimer = setInterval(() => {
    if (sweepInProgress) {
      return;
    }
    sweepInProgress = true;
    void reconcilePluginSchedules().finally(() => {
      sweepInProgress = false;
    });
  }, SWEEP_INTERVAL_MS);
}

/** Stop the periodic reconcile sweep. Used in tests and shutdown. */
export function stopPluginScheduleReconcileSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  sweepInProgress = false;
}
