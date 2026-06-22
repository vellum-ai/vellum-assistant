import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { initGatewayDb, resetGatewayDb } from "../db/connection.js";
import {
  ADMISSION_POLICY_DEFAULT,
  ADMISSION_FLOOR,
  AdmissionPolicyStore,
} from "../db/admission-policy-store.js";
import "./test-preload.js";

// ---------------------------------------------------------------------------
// Setup / teardown
//
// Each test uses unique channelType keys (or `remove()`s its row) to avoid
// cross-test interference; the SQLite file persists across `resetGatewayDb`
// for the duration of the file. There are only seven valid channel ids so
// we deliberately exercise them in different combinations per test.
// ---------------------------------------------------------------------------

let store: AdmissionPolicyStore;

beforeEach(async () => {
  resetGatewayDb();
  await initGatewayDb();
  store = new AdmissionPolicyStore();
  // Clean any rows left by a prior test in the same file.
  for (const row of store.list()) {
    store.remove(row.channelType);
  }
});

afterEach(() => {
  resetGatewayDb();
});

// ---------------------------------------------------------------------------
// Constants sanity
// ---------------------------------------------------------------------------

describe("constants", () => {
  test("ADMISSION_FLOOR orders policies from most-permissive (1) to no_one (5)", () => {
    expect(ADMISSION_FLOOR.strangers).toBe(1);
    expect(ADMISSION_FLOOR.any_contact).toBe(2);
    expect(ADMISSION_FLOOR.trusted_contacts).toBe(3);
    expect(ADMISSION_FLOOR.guardian_only).toBe(4);
    expect(ADMISSION_FLOOR.no_one).toBe(5);
  });

  test("default is trusted_contacts", () => {
    expect(ADMISSION_POLICY_DEFAULT).toBe("trusted_contacts");
  });
});

// ---------------------------------------------------------------------------
// get()
// ---------------------------------------------------------------------------

describe("get()", () => {
  test("returns ADMISSION_POLICY_DEFAULT when no row exists", () => {
    expect(store.get("telegram")).toBe(ADMISSION_POLICY_DEFAULT);
    expect(store.get("phone")).toBe(ADMISSION_POLICY_DEFAULT);
    expect(store.get("slack")).toBe(ADMISSION_POLICY_DEFAULT);
  });
});

// ---------------------------------------------------------------------------
// set() + get() round-trip
// ---------------------------------------------------------------------------

describe("set() + get()", () => {
  test("round-trips a policy", () => {
    const row = store.set("telegram", "no_one", "kill switch on");
    expect(row.channelType).toBe("telegram");
    expect(row.policy).toBe("no_one");
    expect(row.note).toBe("kill switch on");
    expect(typeof row.updatedAt).toBe("number");
    expect(store.get("telegram")).toBe("no_one");
  });

  test("set() with no note stores null", () => {
    const row = store.set("phone", "guardian_only");
    expect(row.note).toBeNull();
    expect(store.get("phone")).toBe("guardian_only");
  });

  test("set() upserts on conflict and refreshes updatedAt", async () => {
    const first = store.set("slack", "trusted_contacts", "initial");
    // Sleep just enough that the second write lands at a later epoch ms,
    // since Date.now() resolution can collapse two adjacent calls.
    await new Promise((r) => setTimeout(r, 2));
    const second = store.set("slack", "any_contact", "loosened");

    expect(second.policy).toBe("any_contact");
    expect(second.note).toBe("loosened");
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
    expect(store.get("slack")).toBe("any_contact");
  });

  test("set() does not leak across channels", () => {
    store.set("telegram", "no_one");
    expect(store.get("telegram")).toBe("no_one");
    expect(store.get("phone")).toBe(ADMISSION_POLICY_DEFAULT);
    expect(store.get("email")).toBe(ADMISSION_POLICY_DEFAULT);
  });
});

// ---------------------------------------------------------------------------
// list()
// ---------------------------------------------------------------------------

describe("list()", () => {
  test("returns only persisted rows (channels with no row are omitted)", () => {
    expect(store.list()).toEqual([]);

    store.set("telegram", "no_one", "off");
    store.set("phone", "guardian_only", null);

    const rows = store.list();
    expect(rows).toHaveLength(2);

    const byChannel = new Map(rows.map((r) => [r.channelType, r]));
    expect(byChannel.get("telegram")?.policy).toBe("no_one");
    expect(byChannel.get("telegram")?.note).toBe("off");
    expect(byChannel.get("phone")?.policy).toBe("guardian_only");
    expect(byChannel.get("phone")?.note).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// remove()
// ---------------------------------------------------------------------------

describe("remove()", () => {
  test("hard-deletes the row and reverts get() to the default", () => {
    store.set("email", "strangers");
    expect(store.get("email")).toBe("strangers");

    const removed = store.remove("email");
    expect(removed).toBe(true);
    expect(store.get("email")).toBe(ADMISSION_POLICY_DEFAULT);
    expect(store.list().find((r) => r.channelType === "email")).toBeUndefined();
  });

  test("returns false when no row was present", () => {
    expect(store.remove("whatsapp")).toBe(false);
  });
});
