import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { initGatewayDb, resetGatewayDb } from "../db/connection.js";
import { AdmissionPolicyStore } from "../db/admission-policy-store.js";
import { seedAdmissionPolicyDefaults } from "../db/seed-admission-policy.js";
import { isChannelId } from "../channels/types.js";
import {
  getAdmissionPolicyCache,
  initAdmissionPolicyCache,
  resetAdmissionPolicyCache,
} from "../risk/admission-policy-cache.js";
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
  resetAdmissionPolicyCache();
  resetGatewayDb();
});

describe("seedAdmissionPolicyDefaults", () => {
  test("seeds enforced channels with their defaults (vellum → guardian_only, rest → trusted_contacts)", () => {
    seedAdmissionPolicyDefaults(store);

    const byChannel = new Map(
      store.list().map((r) => [r.channelType, r.policy]),
    );
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

  test("picks up discord generically — enforced, configurable, seeded at the default floor", () => {
    // Discord carries no entry in CHANNEL_ADMISSION_DEFAULTS and no special
    // casing in the seed: adding it to CHANNEL_IDS is enough to give it a
    // floor, so a channel id can never reach ingress unenforced.
    seedAdmissionPolicyDefaults(store);

    // Enforced — not skipped as exempt — at the universal default.
    expect(store.get("discord")).toBe("trusted_contacts");

    // Configurable: Discord shows in the Channel Trust Floors list, so a
    // user-chosen floor is a setting the seed must respect, not drift to
    // re-pin.
    store.set("discord", "strangers", "user widened discord");
    seedAdmissionPolicyDefaults(store);
    expect(store.get("discord")).toBe("strangers");
  });

  test("seeds vellum-shared as a known channel at a guardian_only floor", () => {
    seedAdmissionPolicyDefaults(store);
    initAdmissionPolicyCache(store);

    expect(isChannelId("vellum-shared")).toBe(true);
    expect(store.get("vellum-shared")).toBe("guardian_only");
    expect(getAdmissionPolicyCache().get("vellum-shared")).toBe(
      "guardian_only",
    );
  });

  test("resets a stranded hidden-channel row back to its default", () => {
    // A legacy/stale row on a now-hidden channel must not strand the channel
    // at a floor the user can no longer see or reset in the UI.
    store.set("whatsapp", "no_one", "legacy kill switch");
    store.set("vellum", "any_contact", "legacy widened vellum");
    store.set("vellum-shared", "strangers", "legacy widened vellum-shared");

    seedAdmissionPolicyDefaults(store);

    expect(store.get("whatsapp")).toBe("trusted_contacts");
    expect(store.get("vellum")).toBe("guardian_only");
    expect(store.get("vellum-shared")).toBe("guardian_only");
  });
});
