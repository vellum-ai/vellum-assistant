import { describe, expect, test } from "bun:test";

import {
  diffDrizzleSchemaContract,
  listDrizzleTables,
  schemaContractIsClean,
} from "./schema-contract.js";

describe("listDrizzleTables", () => {
  test("includes conversations.fork_strategy from the source catalog", () => {
    const conversations = listDrizzleTables().find(
      (table) => table.name === "conversations",
    );
    expect(conversations).toBeDefined();
    expect(conversations!.columns).toContain("fork_strategy");
    expect(conversations!.columns).toContain("id");
  });

  test("de-duplicates aliased table exports", () => {
    const names = listDrizzleTables().map((table) => table.name);
    expect(names.filter((name) => name === "cron_jobs")).toEqual(["cron_jobs"]);
  });
});

describe("diffDrizzleSchemaContract", () => {
  test("reports a missing column on a table that exists", () => {
    const conversations = listDrizzleTables().find(
      (table) => table.name === "conversations",
    );
    expect(conversations).toBeDefined();
    const liveColumns = new Set(
      conversations!.columns.filter((column) => column !== "fork_strategy"),
    );
    const live = new Map<string, Set<string>>(
      listDrizzleTables().map((table) => [
        table.name,
        table.name === "conversations" ? liveColumns : new Set(table.columns),
      ]),
    );

    const report = diffDrizzleSchemaContract(live);
    expect(schemaContractIsClean(report)).toBe(false);
    expect(report.missingTables).toEqual([]);
    expect(report.missingColumns).toEqual([
      { table: "conversations", column: "fork_strategy" },
    ]);
  });

  test("ignores extra SQLite columns that Drizzle does not own", () => {
    const live = new Map<string, Set<string>>(
      listDrizzleTables().map((table) => {
        const columns = new Set(table.columns);
        if (table.name === "conversations") {
          columns.add("group_id");
        }
        return [table.name, columns];
      }),
    );

    const report = diffDrizzleSchemaContract(live);
    expect(schemaContractIsClean(report)).toBe(true);
    expect(report.missingColumns).toEqual([]);
  });

  test("reports a drizzle table that is absent from every live file", () => {
    const live = new Map<string, Set<string>>(
      listDrizzleTables()
        .filter((table) => table.name !== "conversations")
        .map((table) => [table.name, new Set(table.columns)]),
    );

    const report = diffDrizzleSchemaContract(live);
    expect(report.missingTables).toEqual(["conversations"]);
    expect(
      report.missingColumns.some((miss) => miss.table === "conversations"),
    ).toBe(false);
  });
});
