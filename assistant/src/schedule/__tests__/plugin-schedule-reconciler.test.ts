/**
 * Tests for `reconcilePluginSchedules()`.
 *
 * Fixture plugin directories are written under the (per-test-process)
 * workspace plugins dir and converged against the real schedule store; the
 * only stubs are the notification emitter (recorded for assertions) and the
 * background-wake publisher (kept out for hermeticity, mirroring
 * schedule-store.test.ts).
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../background-wake/publisher.js", () => ({
  refreshBackgroundWakeIntent: () => {},
}));

const emittedSignals: Array<Record<string, unknown>> = [];

/** When set, merged into the next emit results (e.g. a failure reason). */
let emitResultOverride: Record<string, unknown> | null = null;

/**
 * When set, an emit records its call and then parks on this promise instead
 * of resolving, so a test can hold one attempt open across further passes.
 */
let emitGate: Promise<void> | null = null;

mock.module("../../notifications/emit-signal.js", () => ({
  emitNotificationSignal: async (params: Record<string, unknown>) => {
    emittedSignals.push(params);
    if (emitGate) {
      await emitGate;
    }
    return {
      signalId: "test-signal",
      deduplicated: false,
      dispatched: true,
      reason: "test",
      deliveryResults: [],
      pipelineFailed: false,
      ...(emitResultOverride ?? {}),
    };
  },
}));

/**
 * Plugin directories the daemon has not activated. The reconciler arms only
 * plugins this process brought up, and no test here runs the plugin loader, so
 * the double answers "activated" unless a case says otherwise.
 */
const notActivatedDirs = new Set<string>();

/** Every directory the reconciler put through the activation predicate. */
const activationProbes: string[] = [];

const realMtimeCache = await import("../../plugins/mtime-cache.js");
mock.module("../../plugins/mtime-cache.js", () => ({
  ...realMtimeCache,
  isPluginDirActivated: (dir: string) => {
    activationProbes.push(dir);
    return !notActivatedDirs.has(dir);
  },
}));

import { setOverridesForTesting } from "../../__tests__/feature-flag-test-helpers.js";
import { getDb } from "../../persistence/db-connection.js";
import { initializeDb } from "../../persistence/db-init.js";
import { listInstalledPluginDirs } from "../../plugins/installed-plugin-dirs.js";
import { getWorkspacePluginsDir } from "../../util/platform.js";
import {
  reconcilePluginSchedules,
  resetDefinitionErrorEmitGuardForTests,
} from "../plugin-schedule-reconciler.js";
import {
  claimDueSchedules,
  createSchedule,
  createScheduleRun,
  listDeclaredSchedules,
  setUserEnabled,
} from "../schedule-store.js";

await initializeDb();

const pluginsDir = getWorkspacePluginsDir();

function getRawDb(): import("bun:sqlite").Database {
  return (getDb() as unknown as { $client: import("bun:sqlite").Database })
    .$client;
}

function rawJob(id: string): Record<string, unknown> {
  return getRawDb()
    .query("SELECT * FROM cron_jobs WHERE id = ?")
    .get(id) as Record<string, unknown>;
}

/**
 * Write a plugin fixture: a `package.json` plus the given files under
 * `schedules/` (paths relative to the schedules dir).
 */
function writePlugin(name: string, files: Record<string, string>): string {
  const dir = join(pluginsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name, version: "1.0.0" }),
  );
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, "schedules", rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

/**
 * A `digest` declaration: a `config.json` holding the given config plus an
 * `index.md` carrying the prompt body.
 */
function digestFiles(
  config: Record<string, unknown>,
  body = "Summarize the day.",
): Record<string, string> {
  return {
    "digest/config.json": JSON.stringify(config),
    "digest/index.md": `${body}\n`,
  };
}

/** The every-minute digest most cases converge. */
function digest(body = "Summarize the day."): Record<string, string> {
  return digestFiles(
    { expression: "* * * * *", description: "Daily digest" },
    body,
  );
}

/**
 * A digest declaration whose recurrence has nothing left to fire: five daily
 * occurrences, all of them in 2020. Well-formed, just finished.
 */
function endedDigest(): Record<string, string> {
  return digestFiles({
    expression: "DTSTART:20200101T090000Z\nRRULE:FREQ=DAILY;COUNT=5",
    expression_syntax: "rrule",
  });
}

/**
 * The same five daily occurrences, shipped switched off and starting at the
 * given DTSTART. A declaration with `enabled: false` inserts its row unarmed:
 * the clock is zeroed, no run sits behind it, and no user choice is recorded.
 */
function disabledDigest(dtstart: string): Record<string, string> {
  return digestFiles({
    expression: `DTSTART:${dtstart}\nRRULE:FREQ=DAILY;COUNT=5`,
    expression_syntax: "rrule",
    enabled: false,
  });
}

/** A digest declaration the parser refuses: its config.json is not JSON. */
function brokenDigest(): Record<string, string> {
  return {
    "digest/config.json": "{not json",
    "digest/index.md": "Summarize the day.\n",
  };
}

/** A script declaration: the engine runs its `index.sh` by path. */
function scriptSync(body = "echo synced"): Record<string, string> {
  return {
    "sync/config.json": JSON.stringify({ expression: "* * * * *" }),
    "sync/index.sh": `#!/bin/sh\n${body}\n`,
  };
}

/** The same script declaration with a config.json the parser refuses. */
function brokenScriptSync(body = "echo unreviewed"): Record<string, string> {
  return {
    "sync/config.json": "{not json",
    "sync/index.sh": `#!/bin/sh\n${body}\n`,
  };
}

const DIGEST_KEY = "plugin:news/digest";

/** Reset the store, the fixture plugins dir, and the emit doubles. */
function resetReconcilerFixtures(): void {
  getDb().run("DELETE FROM cron_runs");
  getDb().run("DELETE FROM cron_jobs");
  rmSync(pluginsDir, { recursive: true, force: true });
  emittedSignals.length = 0;
  emitResultOverride = null;
  emitGate = null;
  notActivatedDirs.clear();
  activationProbes.length = 0;
  resetDefinitionErrorEmitGuardForTests();
}

describe("reconcilePluginSchedules", () => {
  beforeEach(() => {
    resetReconcilerFixtures();
    // The feature ships off, so every case below states the flag it runs
    // under rather than inheriting the registry default.
    setOverridesForTesting({ "plugin-schedules": true });
  });

  /** Let a released emit's continuation, `.then`, and `.finally` all run. */
  async function settleEmits(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  test("converges execute and script declarations into rows the engine claims", async () => {
    writePlugin("news", {
      ...digest(),
      "sync/config.json": JSON.stringify({ expression: "0 */2 * * *" }),
      "sync/index.sh": "#!/bin/sh\necho synced\n",
    });

    await reconcilePluginSchedules();

    const rows = listDeclaredSchedules();
    expect(rows).toHaveLength(2);

    const digestRow = rows.find((r) => r.sourceKey === DIGEST_KEY)!;
    expect(digestRow.mode).toBe("execute");
    expect(digestRow.message).toBe("Summarize the day.");
    expect(digestRow.description).toBe("Daily digest");
    expect(digestRow.enabled).toBe(true);
    expect(digestRow.userEnabled).toBeNull();
    expect(digestRow.definitionHash).toMatch(/^[0-9a-f]{64}$/);

    const sync = rows.find((r) => r.sourceKey === "plugin:news/sync")!;
    expect(sync.mode).toBe("script");
    expect(sync.script).toContain("index.sh");
    expect(sync.message).toBe("");

    // Every newly created armed row announces itself, deduped by hash.
    const declared = emittedSignals.filter(
      (s) => s.sourceEventName === "schedule.declared",
    );
    expect(declared).toHaveLength(2);
    const digestDeclared = declared.find(
      (s) => s.sourceContextId === DIGEST_KEY,
    )!;
    expect(digestDeclared.dedupeKey).toBe(
      `schedule-declared:${DIGEST_KEY}:${digestRow.definitionHash}`,
    );
    expect(digestDeclared.contextPayload).toEqual({
      pluginName: "news",
      scheduleName: "digest",
      sourceKey: DIGEST_KEY,
      cadence: "* * * * *",
    });

    // The untouched engine picks the row up: an every-minute cron is always
    // due within a two-minute claim horizon.
    const claimed = await claimDueSchedules(Date.now() + 120_000);
    expect(claimed.map((j) => j.id)).toContain(digestRow.id);
  });

  test("a repeat pass with unchanged declarations is a no-op", async () => {
    writePlugin("news", digest());
    await reconcilePluginSchedules();
    const row = listDeclaredSchedules()[0]!;
    const before = rawJob(row.id);
    emittedSignals.length = 0;

    await reconcilePluginSchedules();

    expect(rawJob(row.id)).toEqual(before);
    expect(emittedSignals).toHaveLength(0);
  });

  test("an upgrade updates by hash and emits definition_changed for the armed row", async () => {
    writePlugin("news", digest());
    await reconcilePluginSchedules();
    const created = listDeclaredSchedules()[0]!;
    emittedSignals.length = 0;

    writePlugin("news", digest("Summarize the WEEK."));
    await reconcilePluginSchedules();

    const updated = listDeclaredSchedules()[0]!;
    expect(updated.id).toBe(created.id);
    expect(updated.message).toBe("Summarize the WEEK.");
    expect(updated.definitionHash).not.toBe(created.definitionHash);

    expect(emittedSignals).toHaveLength(1);
    const signal = emittedSignals[0]!;
    expect(signal.sourceEventName).toBe("schedule.definition_changed");
    expect(signal.dedupeKey).toBe(
      `schedule-definition-changed:${DIGEST_KEY}:${updated.definitionHash}`,
    );
    expect(signal.contextPayload).toEqual({
      pluginName: "news",
      scheduleName: "digest",
      sourceKey: DIGEST_KEY,
    });
  });

  test("uninstall disarms without deleting rows or runs; reinstall re-links and re-arms", async () => {
    writePlugin("news", digest());
    await reconcilePluginSchedules();
    const created = listDeclaredSchedules()[0]!;
    await createScheduleRun(created.id, "conv-1");

    rmSync(join(pluginsDir, "news"), { recursive: true, force: true });
    await reconcilePluginSchedules();

    const disarmed = listDeclaredSchedules()[0]!;
    expect(disarmed.id).toBe(created.id);
    expect(disarmed.enabled).toBe(false);
    expect(disarmed.sourceKey).toBe(DIGEST_KEY);
    const runs = getRawDb()
      .query("SELECT COUNT(*) AS n FROM cron_runs WHERE job_id = ?")
      .get(created.id) as { n: number };
    expect(runs.n).toBe(1);

    emittedSignals.length = 0;
    writePlugin("news", digest());
    await reconcilePluginSchedules();

    const relinked = listDeclaredSchedules();
    expect(relinked).toHaveLength(1);
    expect(relinked[0]!.id).toBe(created.id);
    expect(relinked[0]!.enabled).toBe(true);
    expect(relinked[0]!.nextRunAt).toBeGreaterThan(0);
    // Re-linking an existing row is not a first arming: no arrival signal.
    expect(
      emittedSignals.filter((s) => s.sourceEventName === "schedule.declared"),
    ).toHaveLength(0);
  });

  test("user_enabled survives upgrades and disarm/re-arm cycles", async () => {
    writePlugin("news", digest());
    await reconcilePluginSchedules();
    const created = listDeclaredSchedules()[0]!;

    await setUserEnabled(created.id, false);
    emittedSignals.length = 0;

    // Upgrade: definition columns update, the user override keeps the row
    // disabled, and no definition_changed emits for an unarmed row.
    writePlugin("news", digest("Summarize the WEEK."));
    await reconcilePluginSchedules();
    let row = listDeclaredSchedules()[0]!;
    expect(row.message).toBe("Summarize the WEEK.");
    expect(row.enabled).toBe(false);
    expect(row.userEnabled).toBe(false);
    expect(emittedSignals).toHaveLength(0);

    // Disarm (uninstall) then re-arm (reinstall): the override still wins.
    rmSync(join(pluginsDir, "news"), { recursive: true, force: true });
    await reconcilePluginSchedules();
    writePlugin("news", digest("Summarize the WEEK."));
    await reconcilePluginSchedules();
    row = listDeclaredSchedules()[0]!;
    expect(row.id).toBe(created.id);
    expect(row.enabled).toBe(false);
    expect(row.userEnabled).toBe(false);
  });

  test("an upgrade that flips a disarmed declaration to enabled arms it and notifies", async () => {
    writePlugin(
      "news",
      digestFiles({ expression: "* * * * *", enabled: false }),
    );
    await reconcilePluginSchedules();
    expect(listDeclaredSchedules()[0]!.enabled).toBe(false);
    expect(emittedSignals).toHaveLength(0);

    writePlugin("news", digest());
    await reconcilePluginSchedules();

    const armed = listDeclaredSchedules()[0]!;
    expect(armed.enabled).toBe(true);
    expect(emittedSignals).toHaveLength(1);
    const signal = emittedSignals[0]!;
    expect(signal.sourceEventName).toBe("schedule.declared");
    expect(signal.dedupeKey).toBe(
      `schedule-declared:${DIGEST_KEY}:${armed.definitionHash}`,
    );
  });

  test("a user override enables a declaration shipped disabled", async () => {
    writePlugin(
      "news",
      digestFiles({ expression: "* * * * *", enabled: false }),
    );
    await reconcilePluginSchedules();
    const created = listDeclaredSchedules()[0]!;
    expect(created.enabled).toBe(false);

    await setUserEnabled(created.id, true);
    await reconcilePluginSchedules();

    const row = listDeclaredSchedules()[0]!;
    expect(row.enabled).toBe(true);
    expect(row.userEnabled).toBe(true);
  });

  test("disabling a plugin pauses its schedules; re-enabling restores them", async () => {
    const dir = writePlugin("news", digest());
    await reconcilePluginSchedules();
    const created = listDeclaredSchedules()[0]!;

    writeFileSync(join(dir, ".disabled"), "");
    await reconcilePluginSchedules();
    expect(listDeclaredSchedules()[0]!.enabled).toBe(false);

    rmSync(join(dir, ".disabled"));
    await reconcilePluginSchedules();
    const restored = listDeclaredSchedules()[0]!;
    expect(restored.id).toBe(created.id);
    expect(restored.enabled).toBe(true);
    expect(restored.userEnabled).toBeNull();
  });

  test("a parse error keeps the last-good execute row running and emits a deduped notification", async () => {
    writePlugin("news", digest());
    await reconcilePluginSchedules();
    const created = listDeclaredSchedules()[0]!;
    const before = rawJob(created.id);
    emittedSignals.length = 0;

    // Break the declaration: a config.json the parser cannot read.
    writePlugin("news", brokenDigest());
    await reconcilePluginSchedules();

    // The row fires the message it was armed with, so nothing unvalidated
    // runs while it stays armed.
    expect(rawJob(created.id)).toEqual(before);
    expect(emittedSignals).toHaveLength(1);
    const signal = emittedSignals[0]!;
    expect(signal.sourceEventName).toBe("schedule.definition_error");
    const day = new Date().toISOString().slice(0, 10);
    expect(signal.dedupeKey).toBe(
      `schedule-definition-error:${DIGEST_KEY}:${day}`,
    );
    const payload = signal.contextPayload as Record<string, unknown>;
    expect(payload.pluginName).toBe("news");
    expect(payload.scheduleName).toBe("digest");
    expect(payload.sourceKey).toBe(DIGEST_KEY);
    expect(typeof payload.reason).toBe("string");
    expect(payload.paused).toBe(false);
  });

  test("a parse error disarms a script row, which re-arms once the declaration parses", async () => {
    writePlugin("news", scriptSync());
    await reconcilePluginSchedules();
    const created = listDeclaredSchedules()[0]!;
    expect(created.mode).toBe("script");
    expect(created.enabled).toBe(true);
    emittedSignals.length = 0;

    // A script row runs its entrypoint by path, so an upgrade the parser
    // refuses would otherwise fire the unreviewed index.sh next to it.
    writePlugin("news", brokenScriptSync());
    await reconcilePluginSchedules();

    const paused = listDeclaredSchedules()[0]!;
    expect(paused.id).toBe(created.id);
    expect(paused.enabled).toBe(false);
    expect(emittedSignals).toHaveLength(1);
    const signal = emittedSignals[0]!;
    expect(signal.sourceEventName).toBe("schedule.definition_error");
    const payload = signal.contextPayload as Record<string, unknown>;
    expect(payload.sourceKey).toBe("plugin:news/sync");
    expect(payload.paused).toBe(true);

    // Fixing the declaration re-arms the same row on the next pass.
    writePlugin("news", scriptSync());
    await reconcilePluginSchedules();

    const rearmed = listDeclaredSchedules()[0]!;
    expect(rearmed.id).toBe(created.id);
    expect(rearmed.enabled).toBe(true);
    expect(rearmed.nextRunAt).toBeGreaterThan(0);
  });

  test("a script row the user turned off reports no pause when its declaration breaks", async () => {
    writePlugin("news", scriptSync());
    await reconcilePluginSchedules();
    const created = listDeclaredSchedules()[0]!;
    await setUserEnabled(created.id, false);
    emittedSignals.length = 0;

    // The row is already off and stays off, so promising the user it resumes
    // once the declaration loads again would be a lie.
    writePlugin("news", brokenScriptSync());
    await reconcilePluginSchedules();

    expect(listDeclaredSchedules()[0]!.enabled).toBe(false);
    expect(emittedSignals).toHaveLength(1);
    const signal = emittedSignals[0]!;
    expect(signal.sourceEventName).toBe("schedule.definition_error");
    const payload = signal.contextPayload as Record<string, unknown>;
    expect(payload.sourceKey).toBe("plugin:news/sync");
    expect(payload.paused).toBe(false);
  });

  test("a user's off choice survives a script row's disarm and re-arm", async () => {
    writePlugin("news", scriptSync());
    await reconcilePluginSchedules();
    const created = listDeclaredSchedules()[0]!;
    await setUserEnabled(created.id, false);

    writePlugin("news", brokenScriptSync());
    await reconcilePluginSchedules();
    writePlugin("news", scriptSync());
    await reconcilePluginSchedules();

    const row = listDeclaredSchedules()[0]!;
    expect(row.enabled).toBe(false);
    expect(row.userEnabled).toBe(false);
  });

  test("an ended recurrence keeps a script row on its last-good definition", async () => {
    writePlugin("news", scriptSync());
    await reconcilePluginSchedules();
    const created = listDeclaredSchedules()[0]!;
    const before = rawJob(created.id);
    emittedSignals.length = 0;

    // A recurrence running out is not a rewrite of the entrypoint, so the
    // last-good handling every mode shares still applies.
    writePlugin("news", {
      "sync/config.json": JSON.stringify({
        expression: "DTSTART:20200101T090000Z\nRRULE:FREQ=DAILY;COUNT=5",
        expression_syntax: "rrule",
      }),
      "sync/index.sh": "#!/bin/sh\necho synced\n",
    });
    await reconcilePluginSchedules();

    expect(rawJob(created.id)).toEqual(before);
    expect(emittedSignals).toHaveLength(1);
    expect(emittedSignals[0]!.sourceEventName).toBe(
      "schedule.definition_error",
    );
  });

  test("engine-latched rows are left untouched by definition changes", async () => {
    writePlugin("news", digest());
    await reconcilePluginSchedules();
    const created = listDeclaredSchedules()[0]!;
    emittedSignals.length = 0;

    // Recurrence exhaustion latch: the claim path disables the row, zeroes
    // nextRunAt, and stamps lastRunAt in one write.
    getRawDb().run(
      "UPDATE cron_jobs SET enabled = 0, next_run_at = 0, last_run_at = ? WHERE id = ?",
      [Date.now(), created.id],
    );
    const latched = rawJob(created.id);

    writePlugin("news", digest("Summarize the WEEK."));
    await reconcilePluginSchedules();

    expect(rawJob(created.id)).toEqual(latched);
    expect(emittedSignals).toHaveLength(0);
  });

  test("imperative rows are byte-identical across passes", async () => {
    const imperative = await createSchedule({
      name: "Mine",
      cronExpression: "0 8 * * *",
      message: "hello",
      syntax: "cron",
    });
    const before = rawJob(imperative.id);

    writePlugin("news", digest());
    await reconcilePluginSchedules();
    rmSync(join(pluginsDir, "news"), { recursive: true, force: true });
    await reconcilePluginSchedules();

    expect(rawJob(imperative.id)).toEqual(before);
  });

  test("concurrent reconciles serialize into one row per declaration", async () => {
    writePlugin("news", digest());

    await Promise.all([reconcilePluginSchedules(), reconcilePluginSchedules()]);

    const rows = listDeclaredSchedules();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sourceKey).toBe(DIGEST_KEY);
  });

  test("a manifest-rejected plugin disarms its schedules and surfaces the failure", async () => {
    const dir = writePlugin("news", digest());
    await reconcilePluginSchedules();
    const created = listDeclaredSchedules()[0]!;
    expect(created.enabled).toBe(true);
    emittedSignals.length = 0;

    // A package.json the loader's schema rejects (empty name): the runtime
    // refuses to bring such a plugin up, so its schedules must disarm too.
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "" }));
    await reconcilePluginSchedules();

    const disarmed = listDeclaredSchedules()[0]!;
    expect(disarmed.id).toBe(created.id);
    expect(disarmed.enabled).toBe(false);
    expect(emittedSignals).toHaveLength(1);
    const signal = emittedSignals[0]!;
    expect(signal.sourceEventName).toBe("schedule.definition_error");
    const payload = signal.contextPayload as Record<string, unknown>;
    expect(payload.pluginName).toBe("news");
    expect(payload.scheduleName).toBe("digest");
    expect(payload.sourceKey).toBe(DIGEST_KEY);
    expect(payload.reason).toContain("package.json");
    // The pass took an armed row off, so the notification says so.
    expect(payload.paused).toBe(true);

    // The failure surfaces once per day, not per pass.
    await reconcilePluginSchedules();
    expect(emittedSignals).toHaveLength(1);

    // Restoring a valid manifest re-arms the row on the next pass.
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "news", version: "1.0.0" }),
    );
    await reconcilePluginSchedules();
    expect(listDeclaredSchedules()[0]!.enabled).toBe(true);
  });

  test("a plugin with an unparseable package.json creates no rows and surfaces the failure", async () => {
    const dir = writePlugin("news", digest());
    writeFileSync(join(dir, "package.json"), "{not json");

    await reconcilePluginSchedules();

    expect(listDeclaredSchedules()).toHaveLength(0);
    expect(emittedSignals).toHaveLength(1);
    expect(emittedSignals[0]!.sourceEventName).toBe(
      "schedule.definition_error",
    );
    // Nothing was ever armed, so nothing was paused.
    const payload = emittedSignals[0]!.contextPayload as Record<
      string,
      unknown
    >;
    expect(payload.paused).toBe(false);
  });

  test("a broken manifest on a plugin without schedules stays silent", async () => {
    const dir = join(pluginsDir, "quiet");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), "{not json");

    await reconcilePluginSchedules();

    expect(listDeclaredSchedules()).toHaveLength(0);
    expect(emittedSignals).toHaveLength(0);
  });

  test("an upgrade that adds a schedule arms it and emits schedule.declared", async () => {
    writePlugin("news", digest());
    await reconcilePluginSchedules();
    emittedSignals.length = 0;

    // The upgraded revision ships an additional declaration alongside the
    // unchanged digest.
    writePlugin("news", {
      "sync/config.json": JSON.stringify({ expression: "0 */2 * * *" }),
      "sync/index.sh": "#!/bin/sh\necho synced\n",
    });
    await reconcilePluginSchedules();

    const sync = listDeclaredSchedules().find(
      (r) => r.sourceKey === "plugin:news/sync",
    )!;
    expect(sync.enabled).toBe(true);
    expect(emittedSignals).toHaveLength(1);
    const signal = emittedSignals[0]!;
    expect(signal.sourceEventName).toBe("schedule.declared");
    expect(signal.dedupeKey).toBe(
      `schedule-declared:plugin:news/sync:${sync.definitionHash}`,
    );
    const payload = signal.contextPayload as Record<string, unknown>;
    expect(payload.pluginName).toBe("news");
    expect(payload.scheduleName).toBe("sync");
    expect(payload.cadence).toBe("0 */2 * * *");
  });

  test("a declaration shipped disabled creates its row silently", async () => {
    writePlugin(
      "news",
      digestFiles({ expression: "* * * * *", enabled: false }),
    );

    await reconcilePluginSchedules();

    expect(listDeclaredSchedules()[0]!.enabled).toBe(false);
    expect(emittedSignals).toHaveLength(0);
  });

  test("a persistently broken declaration emits its error once, not per pass", async () => {
    writePlugin("news", brokenDigest());

    await reconcilePluginSchedules();
    expect(emittedSignals).toHaveLength(1);
    expect(emittedSignals[0]!.sourceEventName).toBe(
      "schedule.definition_error",
    );

    await reconcilePluginSchedules();
    await reconcilePluginSchedules();

    expect(emittedSignals).toHaveLength(1);
  });

  test("a pipeline-failed error emit does not latch the day guard; the next pass retries", async () => {
    writePlugin("news", brokenDigest());
    emitResultOverride = {
      dispatched: false,
      pipelineFailed: true,
      reason: "Signal pipeline failed: transient outage",
    };

    await reconcilePluginSchedules();
    expect(emittedSignals).toHaveLength(1);

    emitResultOverride = null;
    await reconcilePluginSchedules();
    expect(emittedSignals).toHaveLength(2);

    // The completed retry latched the guard, so further passes stay quiet.
    await reconcilePluginSchedules();
    expect(emittedSignals).toHaveLength(2);
  });

  test("an error emit still in flight is not duplicated by the next pass", async () => {
    writePlugin("news", brokenDigest());
    let releaseGate!: () => void;
    emitGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const errors = () =>
      emittedSignals.filter(
        (s) => s.sourceEventName === "schedule.definition_error",
      );

    // The first pass starts the emit and returns without awaiting it.
    await reconcilePluginSchedules();
    expect(errors()).toHaveLength(1);

    // A second attempt while the first is still evaluating would hit
    // event-store dedupe and latch the day guard on that verdict, silencing
    // the retry the first attempt still needs if it goes on to fail.
    await reconcilePluginSchedules();
    expect(errors()).toHaveLength(1);

    // The held attempt fails, so the day guard stays unlatched.
    emitResultOverride = {
      dispatched: false,
      pipelineFailed: true,
      reason: "Signal pipeline failed: transient outage",
    };
    emitGate = null;
    releaseGate();
    await settleEmits();
    expect(errors()).toHaveLength(1);

    emitResultOverride = null;
    await reconcilePluginSchedules();
    expect(errors()).toHaveLength(2);

    // Verdict reached: the day guard latches and further passes stay quiet.
    await reconcilePluginSchedules();
    expect(errors()).toHaveLength(2);
  });

  test("a pipeline-failed declared emit is retried on later passes until a verdict", async () => {
    writePlugin("news", digest());
    emitResultOverride = {
      dispatched: false,
      pipelineFailed: true,
      reason: "Signal pipeline failed: transient outage",
    };
    const declared = () =>
      emittedSignals.filter((s) => s.sourceEventName === "schedule.declared");

    await reconcilePluginSchedules();
    expect(declared()).toHaveLength(1);

    // The row now exists with the current hash, so without the pending
    // retry this pass would be silent and the consent notification lost.
    emitResultOverride = null;
    await reconcilePluginSchedules();
    expect(declared()).toHaveLength(2);

    // Verdict reached: further passes stay quiet.
    await reconcilePluginSchedules();
    expect(declared()).toHaveLength(2);
  });

  test("a declared emit still in flight is not duplicated by the next pass", async () => {
    writePlugin("news", digest());
    let releaseGate!: () => void;
    emitGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const declared = () =>
      emittedSignals.filter((s) => s.sourceEventName === "schedule.declared");

    // The first pass starts the emit and returns without awaiting it.
    await reconcilePluginSchedules();
    expect(declared()).toHaveLength(1);

    // A second attempt while the first is still evaluating would hit
    // event-store dedupe, resolve as a verdict of its own, and clear the
    // pending marker the first attempt still owns.
    await reconcilePluginSchedules();
    expect(declared()).toHaveLength(1);

    // The held attempt fails, so the marker it owns survives.
    emitResultOverride = {
      dispatched: false,
      pipelineFailed: true,
      reason: "Signal pipeline failed: transient outage",
    };
    emitGate = null;
    releaseGate();
    await settleEmits();
    expect(declared()).toHaveLength(1);

    emitResultOverride = null;
    await reconcilePluginSchedules();
    expect(declared()).toHaveLength(2);

    // Verdict reached: further passes stay quiet.
    await reconcilePluginSchedules();
    expect(declared()).toHaveLength(2);
  });

  test("a pipeline-failed definition_changed emit is retried on later passes until a verdict", async () => {
    writePlugin("news", digest());
    await reconcilePluginSchedules();
    emittedSignals.length = 0;
    const changed = () =>
      emittedSignals.filter(
        (s) => s.sourceEventName === "schedule.definition_changed",
      );

    emitResultOverride = {
      dispatched: false,
      pipelineFailed: true,
      reason: "Signal pipeline failed: transient outage",
    };
    writePlugin("news", digest("Summarize the WEEK."));
    await reconcilePluginSchedules();
    expect(changed()).toHaveLength(1);

    // The new hash is already stored, so without the pending retry this pass
    // would be silent and the change notice lost.
    emitResultOverride = null;
    await reconcilePluginSchedules();
    expect(changed()).toHaveLength(2);

    // Verdict reached: further passes stay quiet.
    await reconcilePluginSchedules();
    expect(changed()).toHaveLength(2);
  });

  test("a completed bounded recurrence stays silent across passes", async () => {
    writePlugin("news", digest());
    await reconcilePluginSchedules();
    const created = listDeclaredSchedules()[0]!;

    // The engine latches an exhausted recurrence in one write: disabled,
    // next run zeroed, last run stamped.
    getRawDb().run(
      "UPDATE cron_jobs SET enabled = 0, next_run_at = 0, last_run_at = ? WHERE id = ?",
      [Date.now(), created.id],
    );
    const latched = rawJob(created.id);
    emittedSignals.length = 0;

    // The declaration is unchanged in spirit: its last occurrence simply
    // passed, so the parser now reports it as ended.
    writePlugin("news", endedDigest());
    await reconcilePluginSchedules();
    await reconcilePluginSchedules();

    expect(rawJob(created.id)).toEqual(latched);
    expect(emittedSignals).toHaveLength(0);
  });

  test("an ended recurrence on a still-armed row surfaces the error", async () => {
    writePlugin("news", digest());
    await reconcilePluginSchedules();
    expect(listDeclaredSchedules()[0]!.enabled).toBe(true);
    emittedSignals.length = 0;

    // The armed row expects more firings; an upgrade that ends the
    // recurrence stops them, which the user has to hear about.
    writePlugin("news", endedDigest());
    await reconcilePluginSchedules();

    expect(emittedSignals).toHaveLength(1);
    expect(emittedSignals[0]!.sourceEventName).toBe(
      "schedule.definition_error",
    );
  });

  test("an ended recurrence on a row this pass disarmed still surfaces", async () => {
    const dir = writePlugin("news", digest());
    await reconcilePluginSchedules();
    const created = listDeclaredSchedules()[0]!;

    // Disabling the plugin disarms the row without the engine latching it:
    // `enabled` goes false, the run clock is untouched.
    writeFileSync(join(dir, ".disabled"), "");
    await reconcilePluginSchedules();
    const disarmed = listDeclaredSchedules()[0]!;
    expect(disarmed.enabled).toBe(false);
    expect(disarmed.lastRunAt).toBeNull();
    expect(disarmed.userEnabled).toBeNull();
    emittedSignals.length = 0;

    // The recurrence runs out while the plugin is off. Re-enabling brings back
    // a schedule that can never fire, so the user has to hear about it.
    writePlugin("news", endedDigest());
    rmSync(join(dir, ".disabled"));
    await reconcilePluginSchedules();

    expect(listDeclaredSchedules()[0]!.id).toBe(created.id);
    expect(emittedSignals).toHaveLength(1);
    expect(emittedSignals[0]!.sourceEventName).toBe(
      "schedule.definition_error",
    );
  });

  test("a user-disabled row keeps an ended recurrence quiet", async () => {
    writePlugin("news", digest());
    await reconcilePluginSchedules();
    const created = listDeclaredSchedules()[0]!;
    await setUserEnabled(created.id, false);
    emittedSignals.length = 0;

    // The user turned the schedule off, so its recurrence running out costs
    // no firing they expected.
    writePlugin("news", endedDigest());
    await reconcilePluginSchedules();

    expect(emittedSignals).toHaveLength(0);
  });

  test("a declaration that shipped disabled keeps an ended recurrence quiet", async () => {
    writePlugin("news", disabledDigest("20990101T090000Z"));
    await reconcilePluginSchedules();

    const created = listDeclaredSchedules()[0]!;
    expect(created.enabled).toBe(false);
    expect(created.nextRunAt).toBe(0);
    expect(created.lastRunAt).toBeNull();
    expect(created.userEnabled).toBeNull();
    emittedSignals.length = 0;

    // The row was never armed, so the recurrence running out costs no firing
    // the user was going to get. Telling them every day about a schedule they
    // never turned on is noise.
    writePlugin("news", disabledDigest("20200101T090000Z"));
    await reconcilePluginSchedules();
    await reconcilePluginSchedules();

    expect(emittedSignals).toHaveLength(0);
  });

  test("a freshly installed declaration that is already expired errors", async () => {
    writePlugin("news", endedDigest());

    await reconcilePluginSchedules();

    expect(listDeclaredSchedules()).toHaveLength(0);
    expect(emittedSignals).toHaveLength(1);
    expect(emittedSignals[0]!.sourceEventName).toBe(
      "schedule.definition_error",
    );
    const payload = emittedSignals[0]!.contextPayload as Record<
      string,
      unknown
    >;
    expect(payload.reason).toContain("no upcoming occurrences");
  });

  test("a plugin the daemon never activated arms nothing", async () => {
    // Everything the parser needs is on disk; only the activation is missing,
    // which is what a directory dropped into the plugins root looks like.
    const dir = writePlugin("news", digest());
    notActivatedDirs.add(dir);

    await reconcilePluginSchedules();

    expect(listDeclaredSchedules()).toHaveLength(0);
    expect(emittedSignals).toHaveLength(0);
  });

  test("a row disarms once its plugin is no longer activated", async () => {
    const dir = writePlugin("news", digest());
    await reconcilePluginSchedules();
    const created = listDeclaredSchedules()[0]!;
    expect(created.enabled).toBe(true);

    notActivatedDirs.add(dir);
    await reconcilePluginSchedules();

    const row = listDeclaredSchedules()[0]!;
    expect(row.id).toBe(created.id);
    expect(row.enabled).toBe(false);
  });

  test("a plugin activated between passes arms on the second one", async () => {
    const dir = writePlugin("news", digest());
    notActivatedDirs.add(dir);
    await reconcilePluginSchedules();
    expect(listDeclaredSchedules()).toHaveLength(0);

    notActivatedDirs.delete(dir);
    await reconcilePluginSchedules();

    const rows = listDeclaredSchedules();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sourceKey).toBe(DIGEST_KEY);
    expect(rows[0]!.enabled).toBe(true);
    // The row arms for the first time here, so it announces its arrival.
    const declared = emittedSignals.filter(
      (s) => s.sourceEventName === "schedule.declared",
    );
    expect(declared).toHaveLength(1);
    expect(declared[0]!.sourceContextId).toBe(DIGEST_KEY);
  });

  test("the activation probe sees the directory string the walk yields", async () => {
    // The predicate is keyed by directory path, so the enumeration the
    // reconciler walks and the map the daemon activates into have to agree on
    // the exact string. Both come from `listInstalledPluginDirs`.
    const dir = writePlugin("news", digest());

    await reconcilePluginSchedules();

    expect(listInstalledPluginDirs().map((p) => p.dir)).toEqual([dir]);
    expect(activationProbes).toEqual([dir]);
  });

  test("a suppressed error emit still latches the day guard", async () => {
    writePlugin("news", brokenDigest());
    emitResultOverride = {
      dispatched: false,
      pipelineFailed: false,
      reason: "Signal blocked by deterministic checks: quiet hours",
    };

    await reconcilePluginSchedules();
    await reconcilePluginSchedules();

    expect(emittedSignals).toHaveLength(1);
  });
});

// ── Feature-flag kill switch ────────────────────────────────────────────

describe("reconcilePluginSchedules under the plugin-schedules flag", () => {
  beforeEach(() => {
    resetReconcilerFixtures();
  });

  test("a flag-off pass disarms armed declared rows and creates nothing", async () => {
    setOverridesForTesting({ "plugin-schedules": true });
    writePlugin("news", digest());
    await reconcilePluginSchedules();
    const armed = listDeclaredSchedules();
    expect(armed).toHaveLength(1);
    expect(armed[0]!.enabled).toBe(true);
    emittedSignals.length = 0;

    setOverridesForTesting({ "plugin-schedules": false });
    // A second plugin lands while the feature is off, so the pass has both a
    // row to disarm and a declaration it must refuse to pick up.
    writePlugin("weather", {
      "forecast/config.json": JSON.stringify({ expression: "* * * * *" }),
      "forecast/index.md": "Forecast the day.\n",
    });
    await reconcilePluginSchedules();

    const rows = listDeclaredSchedules();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(armed[0]!.id);
    expect(rows[0]!.enabled).toBe(false);
    expect(emittedSignals).toHaveLength(0);
  });

  test("a flag-off pass emits nothing for a broken declaration", async () => {
    setOverridesForTesting({ "plugin-schedules": false });
    writePlugin("news", brokenDigest());

    await reconcilePluginSchedules();

    expect(listDeclaredSchedules()).toHaveLength(0);
    expect(emittedSignals).toHaveLength(0);
  });

  test("turning the flag back on re-arms the rows it disarmed", async () => {
    setOverridesForTesting({ "plugin-schedules": true });
    writePlugin("news", digest());
    await reconcilePluginSchedules();
    const created = listDeclaredSchedules()[0]!;

    setOverridesForTesting({ "plugin-schedules": false });
    await reconcilePluginSchedules();
    expect(listDeclaredSchedules()[0]!.enabled).toBe(false);

    setOverridesForTesting({ "plugin-schedules": true });
    await reconcilePluginSchedules();

    const rearmed = listDeclaredSchedules();
    expect(rearmed).toHaveLength(1);
    expect(rearmed[0]!.id).toBe(created.id);
    expect(rearmed[0]!.enabled).toBe(true);
    expect(rearmed[0]!.definitionHash).toBe(created.definitionHash);
  });

  test("a user's off choice survives the flag going off and back on", async () => {
    setOverridesForTesting({ "plugin-schedules": true });
    writePlugin("news", digest());
    await reconcilePluginSchedules();
    const created = listDeclaredSchedules()[0]!;
    await setUserEnabled(created.id, false);

    setOverridesForTesting({ "plugin-schedules": false });
    await reconcilePluginSchedules();
    setOverridesForTesting({ "plugin-schedules": true });
    await reconcilePluginSchedules();

    const row = listDeclaredSchedules()[0]!;
    expect(row.userEnabled).toBe(false);
    expect(row.enabled).toBe(false);
  });
});
