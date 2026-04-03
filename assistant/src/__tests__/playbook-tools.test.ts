import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    memory: {},
  }),
}));

// Stub memory job queue to avoid side effects
mock.module("../memory/jobs-store.js", () => ({
  enqueueMemoryJob: () => {},
}));

import type { Database } from "bun:sqlite";

import { executePlaybookCreate } from "../config/bundled-skills/playbooks/tools/playbook-create.js";
import { executePlaybookDelete } from "../config/bundled-skills/playbooks/tools/playbook-delete.js";
import { executePlaybookList } from "../config/bundled-skills/playbooks/tools/playbook-list.js";
import { executePlaybookUpdate } from "../config/bundled-skills/playbooks/tools/playbook-update.js";
import { getDb, initializeDb } from "../memory/db.js";
import type { ToolContext } from "../tools/types.js";

initializeDb();

function getRawDb(): Database {
  return (getDb() as unknown as { $client: Database }).$client;
}

const ctx: ToolContext = {
  workingDir: "/tmp",
  conversationId: "test-conversation",
  trustClass: "guardian",
};

function clearPlaybooks(): void {
  getRawDb().run(
    "DELETE FROM memory_graph_nodes WHERE source_conversations LIKE '%playbook:%'",
  );
}

function extractPlaybookId(content: string): string {
  const match = content.match(/ID: (\S+)/);
  expect(match).not.toBeNull();
  return match![1];
}

// ── playbook_create ─────────────────────────────────────────────────

describe("playbook_create tool", () => {
  beforeEach(clearPlaybooks);

  test("creates a playbook with required fields", async () => {
    const result = await executePlaybookCreate(
      {
        trigger: "meeting request",
        action: "check calendar, propose 3 times",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Playbook created successfully");
    expect(result.content).toContain("meeting request");
    expect(result.content).toContain("check calendar, propose 3 times");
    expect(result.content).toContain("Autonomy: draft for review"); // default
    expect(result.content).toContain("Channel: *"); // default
    expect(result.content).toContain("Category: general"); // default
    expect(result.content).toContain("Priority: 0"); // default
  });

  test("creates a playbook with all optional fields", async () => {
    const result = await executePlaybookCreate(
      {
        trigger: "from:ceo@*",
        action: "prioritize and draft response",
        channel: "email",
        category: "triage",
        autonomy_level: "auto",
        priority: 10,
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("from:ceo@*");
    expect(result.content).toContain("Channel: email");
    expect(result.content).toContain("Category: triage");
    expect(result.content).toContain("Autonomy: execute automatically");
    expect(result.content).toContain("Priority: 10");
  });

  test("creates with notify autonomy level", async () => {
    const result = await executePlaybookCreate(
      {
        trigger: "newsletter",
        action: "archive",
        autonomy_level: "notify",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Autonomy: notify only");
  });

  test("rejects duplicate playbook", async () => {
    await executePlaybookCreate(
      {
        trigger: "unique trigger",
        action: "unique action",
      },
      ctx,
    );

    const result = await executePlaybookCreate(
      {
        trigger: "unique trigger",
        action: "unique action",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("already exists");
  });

  test("rejects missing trigger", async () => {
    const result = await executePlaybookCreate(
      {
        action: "do something",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("trigger is required");
  });

  test("rejects missing action", async () => {
    const result = await executePlaybookCreate(
      {
        trigger: "test trigger",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("action is required");
  });
});

// ── playbook_list ───────────────────────────────────────────────────

describe("playbook_list tool", () => {
  beforeEach(clearPlaybooks);

  test("returns empty message when no playbooks exist", async () => {
    const result = await executePlaybookList({}, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("No playbooks found");
  });

  test("lists all playbooks", async () => {
    await executePlaybookCreate(
      {
        trigger: "meeting request",
        action: "check calendar",
      },
      ctx,
    );
    await executePlaybookCreate(
      {
        trigger: "newsletter",
        action: "archive it",
      },
      ctx,
    );

    const result = await executePlaybookList({}, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Found 2 playbook(s)");
    expect(result.content).toContain("meeting request");
    expect(result.content).toContain("newsletter");
  });

  test("filters by channel", async () => {
    await executePlaybookCreate(
      {
        trigger: "email trigger",
        action: "handle email",
        channel: "email",
      },
      ctx,
    );
    await executePlaybookCreate(
      {
        trigger: "slack trigger",
        action: "handle slack",
        channel: "slack",
      },
      ctx,
    );

    const result = await executePlaybookList({ channel: "email" }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("email trigger");
    expect(result.content).not.toContain("slack trigger");
  });

  test("filters by category", async () => {
    await executePlaybookCreate(
      {
        trigger: "scheduling trigger",
        action: "schedule it",
        category: "scheduling",
      },
      ctx,
    );
    await executePlaybookCreate(
      {
        trigger: "triage trigger",
        action: "triage it",
        category: "triage",
      },
      ctx,
    );

    const result = await executePlaybookList({ category: "scheduling" }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("scheduling trigger");
    expect(result.content).not.toContain("triage trigger");
  });

  test("includes wildcard channel playbooks in channel filter", async () => {
    await executePlaybookCreate(
      {
        trigger: "wildcard trigger",
        action: "handle anything",
        channel: "*",
      },
      ctx,
    );

    const result = await executePlaybookList({ channel: "email" }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("wildcard trigger");
  });
});

// ── playbook_update ─────────────────────────────────────────────────

describe("playbook_update tool", () => {
  beforeEach(clearPlaybooks);

  test("updates the trigger", async () => {
    const createResult = await executePlaybookCreate(
      {
        trigger: "old trigger",
        action: "do something",
      },
      ctx,
    );
    const id = extractPlaybookId(createResult.content);

    const result = await executePlaybookUpdate(
      {
        playbook_id: id,
        trigger: "new trigger",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Playbook updated successfully");
    expect(result.content).toContain("new trigger");
  });

  test("updates multiple fields at once", async () => {
    const createResult = await executePlaybookCreate(
      {
        trigger: "test",
        action: "old action",
      },
      ctx,
    );
    const id = extractPlaybookId(createResult.content);

    const result = await executePlaybookUpdate(
      {
        playbook_id: id,
        action: "new action",
        channel: "slack",
        category: "notifications",
        autonomy_level: "auto",
        priority: 5,
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("new action");
    expect(result.content).toContain("Channel: slack");
    expect(result.content).toContain("Category: notifications");
    expect(result.content).toContain("Autonomy: execute automatically");
    expect(result.content).toContain("Priority: 5");
  });

  test("rejects missing playbook_id", async () => {
    const result = await executePlaybookUpdate(
      {
        trigger: "new trigger",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("playbook_id is required");
  });

  test("returns error for nonexistent playbook_id", async () => {
    const result = await executePlaybookUpdate(
      {
        playbook_id: "nonexistent",
        trigger: "test",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });
});

// ── playbook_delete ─────────────────────────────────────────────────

describe("playbook_delete tool", () => {
  beforeEach(clearPlaybooks);

  test("deletes a playbook", async () => {
    const createResult = await executePlaybookCreate(
      {
        trigger: "delete me",
        action: "to be deleted",
      },
      ctx,
    );
    const id = extractPlaybookId(createResult.content);

    const result = await executePlaybookDelete({ playbook_id: id }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Playbook deleted");
    expect(result.content).toContain("delete me");

    // Verify it no longer appears in list
    const listResult = await executePlaybookList({}, ctx);
    expect(listResult.content).toContain("No playbooks found");
  });

  test("rejects missing playbook_id", async () => {
    const result = await executePlaybookDelete({}, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("playbook_id is required");
  });

  test("returns error for nonexistent playbook_id", async () => {
    const result = await executePlaybookDelete(
      { playbook_id: "nonexistent" },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });
});
