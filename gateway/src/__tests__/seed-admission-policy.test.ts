import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { initGatewayDb, resetGatewayDb } from "../db/connection.js";
import { AdmissionPolicyStore } from "../db/admission-policy-store.js";
import { seedAdmissionPolicyDefaults } from "../db/seed-admission-policy.js";
import "./test-preload.js";

let store: AdmissionPolicyStore;

beforeEach(async () => {
  resetGatewayDb();
  await initGatewayDb();
  store = new AdmissionPolicyStore();
  // Start from an empty table (initGatewayDb already seeds; clear to test seed
  // behaviour in isolation).
  for (const row of store.list()) store.remove(row.channelType);
});

afterEach(() => {
  resetGatewayDb();
});

describe("seedAdmissionPolicyDefaults", () => {
  test("seeds enforced channels with their defaults (vellum → guardian_only, rest → trusted_contacts)", () => {
    seedAdmissionPolicyDefaults(store);

    const byChannel = new Map(store.list().map((r) => [r.channelType, r.policy]));
    expect(byChannel.get("vellum")).toBe("guardian_only");
    expect(byChannel.get("slack")).toBe("trusted_contacts");
    expect(byChannel.get("telegram")).toBe("trusted_contacts");
    expect(byChannel.get("whatsapp")).toBe("trusted_contacts");
    expect(byChannel.get("email")).toBe("trusted_contacts");
    // phone is enforced and seeds with the universal default.
    expect(byChannel.get("phone")).toBe("trusted_contacts");
  });

  test("skips exempt channels (a2a)", () => {
    seedAdmissionPolicyDefaults(store);

    const seen = new Set(store.list().map((r) => r.channelType));
    expect(seen.has("a2a")).toBe(false);
  });

  test("is idempotent and never overwrites a configurable channel's row", () => {
    store.set("slack", "strangers", "user choice");
    store.set("telegram", "any_contact", "user widened telegram");

    seedAdmissionPolicyDefaults(store);
    seedAdmissionPolicyDefaults(store); // second run is a no-op

    expect(store.get("slack")).toBe("strangers");
    expect(store.get("telegram")).toBe("any_contact");
    // A channel the user never touched still gets its seeded default.
    expect(store.get("email")).toBe("trusted_contacts");
  });

  test("resets a stranded hidden-channel row back to its default", () => {
    // A legacy/stale row on a now-hidden channel must not strand the channel
    // at a floor the user can no longer see or reset in the UI.
    store.set("whatsapp", "no_one", "legacy kill switch");
    store.set("vellum", "any_contact", "legacy widened vellum");

    seedAdmissionPolicyDefaults(store);

    expect(store.get("whatsapp")).toBe("trusted_contacts");
    expect(store.get("vellum")).toBe("guardian_only");
  });
});
