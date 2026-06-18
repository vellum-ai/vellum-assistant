import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { initGatewayDb, resetGatewayDb } from "../db/connection.js";
import {
  AdmissionPolicyStore,
  ADMISSION_POLICY_DEFAULT,
} from "../db/admission-policy-store.js";
import {
  initAdmissionPolicyCache,
  resetAdmissionPolicyCache,
  getAdmissionPolicyCache,
} from "../risk/admission-policy-cache.js";
import {
  createChannelAdmissionPolicyListHandler,
  createChannelAdmissionPolicySetHandler,
} from "../http/routes/channel-admission-policy.js";
import { CHANNEL_IDS } from "../channels/types.js";
import { isAdmissionPolicyExemptChannel } from "@vellumai/gateway-client";
import "./test-preload.js";

const NON_EXEMPT_CHANNEL_IDS = CHANNEL_IDS.filter(
  (channel) => !isAdmissionPolicyExemptChannel(channel),
);

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let store: AdmissionPolicyStore;

beforeEach(async () => {
  resetGatewayDb();
  resetAdmissionPolicyCache();
  await initGatewayDb();
  initAdmissionPolicyCache();
  store = new AdmissionPolicyStore();
  for (const row of store.list()) {
    store.remove(row.channelType);
  }
  // Cache may have been initialized before we cleaned; refresh it.
  resetAdmissionPolicyCache();
  initAdmissionPolicyCache();
});

afterEach(() => {
  resetAdmissionPolicyCache();
  resetGatewayDb();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonRequest(url: string, method: string, body?: unknown): Request {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return new Request(url, init);
}

// ---------------------------------------------------------------------------
// GET /v1/channel-admission-policy
// ---------------------------------------------------------------------------

describe("GET /v1/channel-admission-policy", () => {
  test("returns every non-exempt channel id, with defaults for unconfigured channels", async () => {
    const handler = createChannelAdmissionPolicyListHandler();
    const res = await handler(
      jsonRequest("http://localhost/v1/channel-admission-policy", "GET"),
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      policies: Array<{
        channelType: string;
        policy: string;
        note: string | null;
        updatedAt: number | null;
      }>;
    };
    expect(body.policies).toHaveLength(NON_EXEMPT_CHANNEL_IDS.length);
    for (const p of body.policies) {
      expect(p.policy).toBe(ADMISSION_POLICY_DEFAULT);
      expect(p.note).toBeNull();
      expect(p.updatedAt).toBeNull();
    }
    const seen = new Set(body.policies.map((p) => p.channelType));
    for (const channel of NON_EXEMPT_CHANNEL_IDS) {
      expect(seen.has(channel)).toBe(true);
    }
  });

  test("merges persisted rows with default rows for missing channels", async () => {
    store.set("telegram", "no_one", "off");

    const handler = createChannelAdmissionPolicyListHandler();
    const res = await handler(
      jsonRequest("http://localhost/v1/channel-admission-policy", "GET"),
    );
    const body = (await res.json()) as {
      policies: Array<{
        channelType: string;
        policy: string;
        note: string | null;
        updatedAt: number | null;
      }>;
    };
    expect(body.policies).toHaveLength(NON_EXEMPT_CHANNEL_IDS.length);
    const tg = body.policies.find((p) => p.channelType === "telegram");
    expect(tg?.policy).toBe("no_one");
    expect(tg?.note).toBe("off");
    expect(tg?.updatedAt).toBeGreaterThan(0);

    // phone is an enforced channel — it appears with its seeded default.
    const phone = body.policies.find((p) => p.channelType === "phone");
    expect(phone?.policy).toBe(ADMISSION_POLICY_DEFAULT);
  });

  test("omits exempt channel `a2a` but includes the configurable `vellum` and enforced `phone`", async () => {
    // a2a stays exempt (filtered out); vellum is configurable and phone is now
    // enforced — both must surface so the client can manage them.
    store.set("a2a", "guardian_only");
    store.set("vellum", "guardian_only");

    const handler = createChannelAdmissionPolicyListHandler();
    const res = await handler(
      jsonRequest("http://localhost/v1/channel-admission-policy", "GET"),
    );
    const body = (await res.json()) as {
      policies: Array<{ channelType: string }>;
    };
    const seen = new Set(body.policies.map((p) => p.channelType));
    expect(seen.has("a2a")).toBe(false);
    expect(seen.has("phone")).toBe(true);
    expect(seen.has("vellum")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PUT /v1/channel-admission-policy/:channelType
// ---------------------------------------------------------------------------

describe("PUT /v1/channel-admission-policy/:channelType", () => {
  test("upserts a valid policy and invalidates the cache", async () => {
    const handler = createChannelAdmissionPolicySetHandler();
    const res = await handler(
      jsonRequest(
        "http://localhost/v1/channel-admission-policy/slack",
        "PUT",
        { policy: "guardian_only", note: "tight" },
      ),
      "slack",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      policy: { channelType: string; policy: string; note: string | null };
    };
    expect(body.policy.policy).toBe("guardian_only");
    expect(body.policy.note).toBe("tight");

    expect(store.get("slack")).toBe("guardian_only");
    // Cache invalidation: the cache should reflect the new value without a
    // restart. Mirrors trust-rule-cache invalidation semantics.
    expect(getAdmissionPolicyCache().get("slack")).toBe("guardian_only");
  });

  test("rejects unknown channelType with 400", async () => {
    const handler = createChannelAdmissionPolicySetHandler();
    const res = await handler(
      jsonRequest(
        "http://localhost/v1/channel-admission-policy/not-a-channel",
        "PUT",
        { policy: "trusted_contacts" },
      ),
      "not-a-channel",
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Unknown channelType");
  });

  test("rejects invalid policy with 400", async () => {
    const handler = createChannelAdmissionPolicySetHandler();
    const res = await handler(
      jsonRequest(
        "http://localhost/v1/channel-admission-policy/email",
        "PUT",
        { policy: "lets-everyone-in" },
      ),
      "email",
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/policy/);
  });

  test("rejects malformed JSON with 400", async () => {
    const handler = createChannelAdmissionPolicySetHandler();
    const req = new Request(
      "http://localhost/v1/channel-admission-policy/email",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "{not-json",
      },
    );
    const res = await handler(req, "email");
    expect(res.status).toBe(400);
  });

  test("missing note is stored as null", async () => {
    const handler = createChannelAdmissionPolicySetHandler();
    const res = await handler(
      jsonRequest(
        "http://localhost/v1/channel-admission-policy/whatsapp",
        "PUT",
        { policy: "any_contact" },
      ),
      "whatsapp",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      policy: { note: string | null };
    };
    expect(body.policy.note).toBeNull();
  });

  test("allows configuring `vellum` to a non-kill-switch policy", async () => {
    const handler = createChannelAdmissionPolicySetHandler();
    const res = await handler(
      jsonRequest("http://localhost/v1/channel-admission-policy/vellum", "PUT", {
        policy: "guardian_only",
      }),
      "vellum",
    );
    expect(res.status).toBe(200);
    expect(store.get("vellum")).toBe("guardian_only");
  });

  test("rejects setting `vellum` to `no_one` with 422 (kill-switch forbidden)", async () => {
    const handler = createChannelAdmissionPolicySetHandler();
    const res = await handler(
      jsonRequest("http://localhost/v1/channel-admission-policy/vellum", "PUT", {
        policy: "no_one",
      }),
      "vellum",
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; channelType: string };
    expect(body.error).toMatch(/cannot be set to "no_one"/);
    expect(body.channelType).toBe("vellum");
    // Nothing was persisted.
    expect(store.get("vellum")).toBe(ADMISSION_POLICY_DEFAULT);
  });

  test("§8.1: rejects PUT for exempt channel `a2a` with 403", async () => {
    const handler = createChannelAdmissionPolicySetHandler();
    const res = await handler(
      jsonRequest("http://localhost/v1/channel-admission-policy/a2a", "PUT", {
        policy: "guardian_only",
      }),
      "a2a",
    );
    expect(res.status).toBe(403);
    expect(store.get("a2a")).toBe(ADMISSION_POLICY_DEFAULT);
  });

  test("upserts `phone` like any enforced channel (voice ingress wired)", async () => {
    const handler = createChannelAdmissionPolicySetHandler();
    const res = await handler(
      jsonRequest("http://localhost/v1/channel-admission-policy/phone", "PUT", {
        policy: "strangers",
      }),
      "phone",
    );
    expect(res.status).toBe(200);
    expect(store.get("phone")).toBe("strangers");
  });
});

// ---------------------------------------------------------------------------
// GET /v1/channel-admission-policy (phone enforced)
// ---------------------------------------------------------------------------

describe("GET /v1/channel-admission-policy — phone enforced", () => {
  test("includes `phone` in the list response", async () => {
    const handler = createChannelAdmissionPolicyListHandler();
    const res = await handler(
      jsonRequest("http://localhost/v1/channel-admission-policy", "GET"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { policies: Array<{ channelType: string }> };
    const seen = new Set(body.policies.map((p) => p.channelType));
    expect(seen.has("phone")).toBe(true);
    // Confirm other non-exempt channels still appear.
    expect(seen.has("telegram")).toBe(true);
    expect(seen.has("slack")).toBe(true);
  });
});
