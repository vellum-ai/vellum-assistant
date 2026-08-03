import { beforeEach, describe, expect, test } from "bun:test";

import { getDb } from "../../persistence/db-connection.js";
import { initializeDb } from "../../persistence/db-init.js";
import {
  resetSubagentAttributionCacheForTests,
  resolveSubagentAttribution,
} from "../subagent-attribution.js";

await initializeDb();

let counter = 0;

function insertConversation(opts: {
  subagentRole?: string;
  subagentSpawnMode?: string;
}): string {
  counter += 1;
  const id = `conv-attr-${counter}`;
  const db = getDb();
  db.run(
    `INSERT INTO conversations (id, conversation_type, created_at, updated_at, subagent_role, subagent_spawn_mode)
     VALUES ('${id}', 'background', 1000, 1000, ${
       opts.subagentRole === undefined ? "NULL" : `'${opts.subagentRole}'`
     }, ${
       opts.subagentSpawnMode === undefined
         ? "NULL"
         : `'${opts.subagentSpawnMode}'`
     })`,
  );
  return id;
}

describe("resolveSubagentAttribution", () => {
  beforeEach(() => {
    resetSubagentAttributionCacheForTests();
  });

  test("returns the stamped role and spawn mode for a subagent conversation", () => {
    const id = insertConversation({
      subagentRole: "advisor",
      subagentSpawnMode: "advisor_consult",
    });

    expect(resolveSubagentAttribution(id)).toEqual({
      subagentRole: "advisor",
      subagentSpawnMode: "advisor_consult",
    });
  });

  test("returns nulls for an ordinary conversation", () => {
    const id = insertConversation({});

    expect(resolveSubagentAttribution(id)).toEqual({
      subagentRole: null,
      subagentSpawnMode: null,
    });
  });

  test("returns nulls without a conversation id", () => {
    expect(resolveSubagentAttribution(undefined)).toEqual({
      subagentRole: null,
      subagentSpawnMode: null,
    });
    expect(resolveSubagentAttribution("")).toEqual({
      subagentRole: null,
      subagentSpawnMode: null,
    });
  });

  test("returns nulls for an unknown conversation and does not cache the miss", () => {
    // The columns are stamped at conversation creation, so a miss means the
    // row has not landed yet, and caching it would pin an empty result.
    expect(resolveSubagentAttribution("conv-not-yet")).toEqual({
      subagentRole: null,
      subagentSpawnMode: null,
    });

    const db = getDb();
    db.run(
      `INSERT INTO conversations (id, conversation_type, created_at, updated_at, subagent_role, subagent_spawn_mode)
       VALUES ('conv-not-yet', 'background', 1000, 1000, 'coder', 'regular')`,
    );

    expect(resolveSubagentAttribution("conv-not-yet")).toEqual({
      subagentRole: "coder",
      subagentSpawnMode: "regular",
    });
  });

  test("memoizes a resolved conversation", () => {
    const id = insertConversation({
      subagentRole: "general",
      subagentSpawnMode: "fork",
    });
    expect(resolveSubagentAttribution(id).subagentSpawnMode).toBe("fork");

    // The columns are immutable after creation, so a later write must not be
    // observable, proving the second call did not hit the database.
    const db = getDb();
    db.run(
      `UPDATE conversations SET subagent_spawn_mode = 'regular' WHERE id = '${id}'`,
    );

    expect(resolveSubagentAttribution(id).subagentSpawnMode).toBe("fork");
    resetSubagentAttributionCacheForTests();
    expect(resolveSubagentAttribution(id).subagentSpawnMode).toBe("regular");
  });
});
