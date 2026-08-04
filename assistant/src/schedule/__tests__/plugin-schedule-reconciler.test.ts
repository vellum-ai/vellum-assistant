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

mock.module("../../notifications/emit-signal.js", () => ({
  emitNotificationSignal: async (params: Record<string, unknown>) => {
    emittedSignals.push(params);
    return {
      signalId: "test-signal",
      deduplicated: false,
      dispatched: true,
      reason: "test",
      deliveryResults: [],
    };
  },
}));

import { getDb } from "../../persistence/db-connection.js";
import { initializeDb } from "../../persistence/db-init.js";
import { getWorkspacePluginsDir } from "../../util/platform.js";
import { reconcilePluginSchedules } from "../plugin-schedule-reconciler.js";
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

function digestMd(body: string): string {
  return [
    "---",
    'expression: "* * * * *"',
    "description: Daily digest",
    "---",
    "",
    body,
    "",
  ].join("\n");
}

const DIGEST_KEY = "plugin:news/digest";

describe("reconcilePluginSchedules", () => {
  beforeEach(() => {
    getDb().run("DELETE FROM cron_runs");
    getDb().run("DELETE FROM cron_jobs");
    rmSync(pluginsDir, { recursive: true, force: true });
    emittedSignals.length = 0;
  });

  test("converges both declaration forms into rows the engine claims", async () => {
    writePlugin("news", {
      "digest.md": digestMd("Summarize the day."),
      "sync/config.json": JSON.stringify({ expression: "0 */2 * * *" }),
      "sync/index.sh": "#!/bin/sh\necho synced\n",
    });

    await reconcilePluginSchedules();

    const rows = listDeclaredSchedules();
    expect(rows).toHaveLength(2);

    const digest = rows.find((r) => r.sourceKey === DIGEST_KEY)!;
    expect(digest.mode).toBe("execute");
    expect(digest.message).toBe("Summarize the day.");
    expect(digest.description).toBe("Daily digest");
    expect(digest.enabled).toBe(true);
    expect(digest.userEnabled).toBeNull();
    expect(digest.definitionHash).toMatch(/^[0-9a-f]{64}$/);

    const sync = rows.find((r) => r.sourceKey === "plugin:news/sync")!;
    expect(sync.mode).toBe("script");
    expect(sync.script).toContain("index.sh");
    expect(sync.message).toBe("");

    // The untouched engine picks the row up: an every-minute cron is always
    // due within a two-minute claim horizon.
    const claimed = await claimDueSchedules(Date.now() + 120_000);
    expect(claimed.map((j) => j.id)).toContain(digest.id);
  });

  test("a repeat pass with unchanged declarations is a no-op", async () => {
    writePlugin("news", { "digest.md": digestMd("Summarize the day.") });
    await reconcilePluginSchedules();
    const row = listDeclaredSchedules()[0]!;
    const before = rawJob(row.id);

    await reconcilePluginSchedules();

    expect(rawJob(row.id)).toEqual(before);
    expect(emittedSignals).toHaveLength(0);
  });

  test("an upgrade updates by hash and emits definition_changed for the armed row", async () => {
    writePlugin("news", { "digest.md": digestMd("Summarize the day.") });
    await reconcilePluginSchedules();
    const created = listDeclaredSchedules()[0]!;

    writePlugin("news", { "digest.md": digestMd("Summarize the WEEK.") });
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
    writePlugin("news", { "digest.md": digestMd("Summarize the day.") });
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

    writePlugin("news", { "digest.md": digestMd("Summarize the day.") });
    await reconcilePluginSchedules();

    const relinked = listDeclaredSchedules();
    expect(relinked).toHaveLength(1);
    expect(relinked[0]!.id).toBe(created.id);
    expect(relinked[0]!.enabled).toBe(true);
    expect(relinked[0]!.nextRunAt).toBeGreaterThan(0);
  });

  test("user_enabled survives upgrades and disarm/re-arm cycles", async () => {
    writePlugin("news", { "digest.md": digestMd("Summarize the day.") });
    await reconcilePluginSchedules();
    const created = listDeclaredSchedules()[0]!;

    await setUserEnabled(created.id, false);

    // Upgrade: definition columns update, the user override keeps the row
    // disabled, and no definition_changed emits for an unarmed row.
    writePlugin("news", { "digest.md": digestMd("Summarize the WEEK.") });
    await reconcilePluginSchedules();
    let row = listDeclaredSchedules()[0]!;
    expect(row.message).toBe("Summarize the WEEK.");
    expect(row.enabled).toBe(false);
    expect(row.userEnabled).toBe(false);
    expect(emittedSignals).toHaveLength(0);

    // Disarm (uninstall) then re-arm (reinstall): the override still wins.
    rmSync(join(pluginsDir, "news"), { recursive: true, force: true });
    await reconcilePluginSchedules();
    writePlugin("news", { "digest.md": digestMd("Summarize the WEEK.") });
    await reconcilePluginSchedules();
    row = listDeclaredSchedules()[0]!;
    expect(row.id).toBe(created.id);
    expect(row.enabled).toBe(false);
    expect(row.userEnabled).toBe(false);
  });

  test("a user override enables a declaration shipped disabled", async () => {
    writePlugin("news", {
      "digest.md": [
        "---",
        'expression: "* * * * *"',
        "enabled: false",
        "---",
        "",
        "Summarize the day.",
        "",
      ].join("\n"),
    });
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
    const dir = writePlugin("news", {
      "digest.md": digestMd("Summarize the day."),
    });
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

  test("a parse error keeps the last-good row running and emits a deduped notification", async () => {
    writePlugin("news", { "digest.md": digestMd("Summarize the day.") });
    await reconcilePluginSchedules();
    const created = listDeclaredSchedules()[0]!;
    const before = rawJob(created.id);

    // Break the declaration: no frontmatter means no config.
    writePlugin("news", { "digest.md": "Just a body, no config." });
    await reconcilePluginSchedules();

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
  });

  test("engine-latched rows are left untouched by definition changes", async () => {
    writePlugin("news", { "digest.md": digestMd("Summarize the day.") });
    await reconcilePluginSchedules();
    const created = listDeclaredSchedules()[0]!;

    // Recurrence exhaustion latch: the claim path disables the row, zeroes
    // nextRunAt, and stamps lastRunAt in one write.
    getRawDb().run(
      "UPDATE cron_jobs SET enabled = 0, next_run_at = 0, last_run_at = ? WHERE id = ?",
      [Date.now(), created.id],
    );
    const latched = rawJob(created.id);

    writePlugin("news", { "digest.md": digestMd("Summarize the WEEK.") });
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

    writePlugin("news", { "digest.md": digestMd("Summarize the day.") });
    await reconcilePluginSchedules();
    rmSync(join(pluginsDir, "news"), { recursive: true, force: true });
    await reconcilePluginSchedules();

    expect(rawJob(imperative.id)).toEqual(before);
  });

  test("concurrent reconciles serialize into one row per declaration", async () => {
    writePlugin("news", { "digest.md": digestMd("Summarize the day.") });

    await Promise.all([reconcilePluginSchedules(), reconcilePluginSchedules()]);

    const rows = listDeclaredSchedules();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sourceKey).toBe(DIGEST_KEY);
  });
});
