/**
 * The schedule list and detail routes say why a plugin-sourced schedule is
 * off, so a client never has to show an unexplained disabled row.
 *
 * The reason is derived from the row plus the plugin's files, so the fixtures
 * here write real plugin directories under the per-test-process workspace
 * plugins dir and converge them against the real schedule store.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";

import { setOverridesForTesting } from "../../../__tests__/feature-flag-test-helpers.js";
import { getDb } from "../../../persistence/db-connection.js";
import { initializeDb } from "../../../persistence/db-init.js";
import {
  createSchedule,
  setUserEnabled,
  upsertDeclaredSchedule,
} from "../../../schedule/schedule-store.js";
import { getWorkspacePluginsDir } from "../../../util/platform.js";
import { ROUTES } from "../schedule-routes.js";

await initializeDb();

const pluginsDir = getWorkspacePluginsDir();

function routeHandler(operationId: string) {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`${operationId} route not found`);
  }
  return route.handler;
}

const listHandler = routeHandler("listSchedules");
const getHandler = routeHandler("getSchedule");

interface SerializedSchedule {
  id: string;
  sourceKey: string | null;
  enabled: boolean;
  disarmReason: string | null;
}

async function listed(id: string): Promise<SerializedSchedule> {
  const { schedules } = (await listHandler({ queryParams: {} })) as {
    schedules: SerializedSchedule[];
  };
  const found = schedules.find((s) => s.id === id);
  if (!found) {
    throw new Error(`schedule ${id} missing from the list response`);
  }
  return found;
}

async function fetched(id: string): Promise<SerializedSchedule> {
  const { schedule } = (await getHandler({ pathParams: { id } })) as {
    schedule: SerializedSchedule;
  };
  return schedule;
}

/** Write a plugin dir holding one `schedules/<name>/` declaration. */
function writePlugin(
  pluginName: string,
  options: { declaration?: string; disabled?: boolean } = {},
): void {
  const dir = join(pluginsDir, pluginName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: pluginName, version: "1.0.0" }),
  );
  if (options.declaration) {
    const declarationDir = join(dir, "schedules", options.declaration);
    mkdirSync(declarationDir, { recursive: true });
    writeFileSync(
      join(declarationDir, "config.json"),
      JSON.stringify({ expression: "* * * * *" }),
    );
    writeFileSync(join(declarationDir, "index.md"), "Summarize the day.\n");
  }
  if (options.disabled) {
    writeFileSync(join(dir, ".disabled"), "");
  }
}

/** A declared row for `plugin:<pluginName>/digest`, armed or not. */
async function declaredRow(
  pluginName: string,
  enabled: boolean,
): Promise<string> {
  const job = await upsertDeclaredSchedule(`plugin:${pluginName}/digest`, {
    name: `${pluginName}-digest`,
    description: "Daily digest",
    syntax: "cron",
    expression: "* * * * *",
    message: "Summarize the day.",
    mode: "execute",
    enabled,
    definitionHash: `hash-${pluginName}`,
  });
  return job.id;
}

/** Stamp the engine's exhaust latch onto a row: off, spent, and last run. */
function latchAsCompleted(id: string): void {
  getDb().run(
    `UPDATE cron_jobs SET enabled = 0, next_run_at = 0, last_run_at = ${Date.now()} WHERE id = '${id}'`,
  );
}

beforeEach(() => {
  getDb().run("DELETE FROM cron_runs");
  getDb().run("DELETE FROM cron_jobs");
  rmSync(pluginsDir, { recursive: true, force: true });
  // The feature ships off, so every case states the flag it runs under rather
  // than inheriting the registry default.
  setOverridesForTesting({ "plugin-schedules": true });
});

describe("schedule serialization: disarmReason", () => {
  test("a user's own override outranks whatever the plugin's files say", async () => {
    writePlugin("news", { declaration: "digest" });
    const id = await declaredRow("news", true);
    await setUserEnabled(id, false);

    expect((await listed(id)).disarmReason).toBe("user_disabled");
    expect((await fetched(id)).disarmReason).toBe("user_disabled");
  });

  test("a plugin that is gone from disk reads as removed", async () => {
    const id = await declaredRow("news", false);

    expect((await listed(id)).disarmReason).toBe("plugin_removed");
    expect((await fetched(id)).disarmReason).toBe("plugin_removed");
  });

  test("a plugin carrying the .disabled sentinel reads as disabled", async () => {
    writePlugin("news", { declaration: "digest", disabled: true });
    const id = await declaredRow("news", false);

    expect((await listed(id)).disarmReason).toBe("plugin_disabled");
    expect((await fetched(id)).disarmReason).toBe("plugin_disabled");
  });

  test("a declaration dropped from a plugin that is still installed", async () => {
    writePlugin("news");
    const id = await declaredRow("news", false);

    expect((await listed(id)).disarmReason).toBe("declaration_removed");
    expect((await fetched(id)).disarmReason).toBe("declaration_removed");
  });

  test("a declaration still on disk means the plugin's files turned it off", async () => {
    writePlugin("news", { declaration: "digest" });
    const id = await declaredRow("news", false);

    expect((await listed(id)).disarmReason).toBe("declaration_disabled");
    expect((await fetched(id)).disarmReason).toBe("declaration_disabled");
  });

  test("an armed plugin row has no reason to give", async () => {
    writePlugin("news", { declaration: "digest" });
    const id = await declaredRow("news", true);

    const row = await listed(id);
    expect(row.enabled).toBe(true);
    expect(row.disarmReason).toBeNull();
    expect((await fetched(id)).disarmReason).toBeNull();
  });

  test("a run-to-completion row reads as finished, not paused", async () => {
    writePlugin("news", { declaration: "digest" });
    const id = await declaredRow("news", true);
    latchAsCompleted(id);

    const row = await listed(id);
    expect(row.enabled).toBe(false);
    expect(row.disarmReason).toBeNull();
    expect((await fetched(id)).disarmReason).toBeNull();
  });

  test("the kill switch being off is not a per-row cause", async () => {
    writePlugin("news", { declaration: "digest" });
    const id = await declaredRow("news", false);
    setOverridesForTesting({ "plugin-schedules": false });

    const row = await listed(id);
    expect(row.enabled).toBe(false);
    expect(row.disarmReason).toBeNull();
    expect((await fetched(id)).disarmReason).toBeNull();
  });

  test("a user-created schedule never carries one, off or on", async () => {
    const job = await createSchedule({
      name: "wt-imperative",
      description: "d",
      message: "do the thing",
      mode: "execute",
      enabled: false,
      timezone: null,
      expression: "* * * * *",
      syntax: "cron",
    });

    const row = await listed(job.id);
    expect(row.sourceKey).toBeNull();
    expect(row.enabled).toBe(false);
    expect(row.disarmReason).toBeNull();
    expect((await fetched(job.id)).disarmReason).toBeNull();
  });
});
