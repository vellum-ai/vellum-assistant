import { describe, expect, test } from "bun:test";

import { parseLockfile, type Lockfile } from "./lockfile-contract";

describe("parseLockfile", () => {
  test("passes through a fully-populated lockfile", () => {
    const raw = {
      activeAssistant: "asst_1",
      assistants: [
        {
          assistantId: "asst_1",
          name: "Alice",
          cloud: "vellum",
          runtimeUrl: "http://127.0.0.1:7777",
          species: "vellum",
          hatchedAt: "2026-01-01T00:00:00.000Z",
          organizationId: "org_1",
          resources: { gatewayPort: 7777, daemonPort: 7778 },
        },
      ],
    };

    expect(parseLockfile(raw)).toEqual(raw as Lockfile);
  });

  test("keeps entries missing only optional fields", () => {
    const raw = {
      activeAssistant: null,
      assistants: [
        { assistantId: "asst_1", cloud: "vellum", runtimeUrl: "https://x" },
      ],
    };

    const parsed = parseLockfile(raw);
    expect(parsed.assistants).toHaveLength(1);
    expect(parsed.assistants[0]).toEqual({
      assistantId: "asst_1",
      cloud: "vellum",
      runtimeUrl: "https://x",
    });
  });

  test("salvages a legacy entry that has only an assistantId", () => {
    // The oldest persisted entries carry just the identity; the CLI fills the
    // rest in lazily. assistantId is the only required field, so the entry
    // must survive intact rather than being discarded.
    const parsed = parseLockfile({
      activeAssistant: "asst_1",
      assistants: [{ assistantId: "asst_1" }],
    });
    expect(parsed.assistants).toEqual([{ assistantId: "asst_1" }]);
  });

  test("salvages an entry whose cloud and runtimeUrl are absent", () => {
    // Older CLI builds predate the `cloud` field and persisted the runtime URL
    // under a different key (`localUrl`), so a real on-disk entry can lack both
    // modeled fields. It must still be returned (the macOS↔CLI skew window).
    const parsed = parseLockfile({
      activeAssistant: null,
      assistants: [{ assistantId: "asst_1", localUrl: "http://127.0.0.1:7777" }],
    });
    expect(parsed.assistants).toEqual([{ assistantId: "asst_1" }]);
  });

  test("drops malformed entries but salvages valid siblings", () => {
    const raw = {
      activeAssistant: "asst_ok",
      assistants: [
        { assistantId: "asst_ok", cloud: "local", runtimeUrl: "http://a" },
        { cloud: "local", runtimeUrl: "http://b" }, // missing assistantId
        { assistantId: 42, cloud: "local", runtimeUrl: "http://c" }, // wrong type
        "not-an-object",
      ],
    };

    const parsed = parseLockfile(raw);
    expect(parsed.assistants).toEqual([
      { assistantId: "asst_ok", cloud: "local", runtimeUrl: "http://a" },
    ]);
    expect(parsed.activeAssistant).toBe("asst_ok");
  });

  test("accepts (does not reject) entries with unknown fields from a newer writer", () => {
    const raw = {
      activeAssistant: "asst_1",
      schemaVersion: 99, // unknown top-level field from a newer writer
      assistants: [
        {
          assistantId: "asst_1",
          cloud: "local",
          runtimeUrl: "http://a",
          futureField: { nested: true }, // unknown entry field
        },
      ],
    };

    // A newer writer's extra fields must never make an older reader reject the
    // entry. The entry survives with its modeled fields; the wire value is the
    // validated shape (extra fields are stripped from it — the on-disk file
    // keeps them, see lockfile.test.ts).
    const parsed = parseLockfile(raw);
    expect(parsed.assistants).toEqual([
      { assistantId: "asst_1", cloud: "local", runtimeUrl: "http://a" },
    ]);
    expect(parsed.activeAssistant).toBe("asst_1");
  });

  test("defaults missing or non-array assistants to an empty list", () => {
    expect(parseLockfile({}).assistants).toEqual([]);
    expect(parseLockfile({ assistants: "nope" }).assistants).toEqual([]);
  });

  test("coerces a non-string activeAssistant to null", () => {
    expect(parseLockfile({ assistants: [], activeAssistant: 7 }).activeAssistant).toBeNull();
    expect(parseLockfile({ assistants: [] }).activeAssistant).toBeNull();
  });

  test("returns the empty lockfile for non-object input", () => {
    const empty: Lockfile = { assistants: [], activeAssistant: null };
    expect(parseLockfile(null)).toEqual(empty);
    expect(parseLockfile(undefined)).toEqual(empty);
    expect(parseLockfile("[]")).toEqual(empty);
    expect(parseLockfile(123)).toEqual(empty);
  });

  test("drops a mistyped optional field but keeps the entry", () => {
    // assistantId is the only required field. A mistyped optional field (here
    // cloud / runtimeUrl) is dropped from the result, but the entry survives on
    // the strength of its identity rather than being discarded wholesale.
    const raw = {
      assistants: [
        { assistantId: "asst_1", cloud: 7, runtimeUrl: "http://a" }, // cloud not a string
        { assistantId: "asst_2", cloud: "local", runtimeUrl: 7 }, // runtimeUrl not a string
      ],
      activeAssistant: null,
    };
    expect(parseLockfile(raw).assistants).toEqual([
      { assistantId: "asst_1", runtimeUrl: "http://a" },
      { assistantId: "asst_2", cloud: "local" },
    ]);
  });

  test("drops an entry only when its assistantId is missing or mistyped", () => {
    const raw = {
      assistants: [
        { cloud: "local", runtimeUrl: "http://a" }, // no assistantId
        { assistantId: 42, cloud: "local" }, // assistantId not a string
      ],
      activeAssistant: null,
    };
    expect(parseLockfile(raw).assistants).toEqual([]);
  });

  test("keeps organizationId on platform entries and drops it when mistyped", () => {
    // Platform assistants carry their owning org so the host proxy can scope
    // requests without guessing; local entries simply omit it.
    const raw = {
      assistants: [
        { assistantId: "asst_1", cloud: "vellum", organizationId: "org_1" },
        { assistantId: "asst_2", cloud: "vellum", organizationId: 7 }, // mistyped
        { assistantId: "asst_3", cloud: "local" }, // local, no org
      ],
      activeAssistant: null,
    };
    expect(parseLockfile(raw).assistants).toEqual([
      { assistantId: "asst_1", cloud: "vellum", organizationId: "org_1" },
      { assistantId: "asst_2", cloud: "vellum" },
      { assistantId: "asst_3", cloud: "local" },
    ]);
  });

  test("drops a resources object missing its numeric ports", () => {
    const raw = {
      assistants: [
        {
          assistantId: "asst_1",
          cloud: "local",
          runtimeUrl: "http://a",
          resources: { gatewayPort: "7777", daemonPort: 7778 },
        },
      ],
      activeAssistant: null,
    };
    const [assistant] = parseLockfile(raw).assistants;
    expect(assistant).toEqual({
      assistantId: "asst_1",
      cloud: "local",
      runtimeUrl: "http://a",
    });
    expect(assistant?.resources).toBeUndefined();
  });
});
