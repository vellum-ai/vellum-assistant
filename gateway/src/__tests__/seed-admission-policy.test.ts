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
  });

  test("skips exempt channels (a2a, phone)", () => {
    seedAdmissionPolicyDefaults(store);

    const seen = new Set(store.list().map((r) => r.channelType));
    expect(seen.has("a2a")).toBe(false);
    expect(seen.has("phone")).toBe(false);
  });

  test("is idempotent and never overwrites a user-configured row", () => {
    store.set("slack", "strangers", "user choice");
    store.set("vellum", "trusted_contacts", "user widened vellum");

    seedAdmissionPolicyDefaults(store);
    seedAdmissionPolicyDefaults(store); // second run is a no-op

    expect(store.get("slack")).toBe("strangers");
    expect(store.get("vellum")).toBe("trusted_contacts");
    // A channel the user never touched still gets its seeded default.
    expect(store.get("email")).toBe("trusted_contacts");
  });
});
