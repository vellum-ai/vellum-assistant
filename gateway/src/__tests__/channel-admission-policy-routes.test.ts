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
import "./test-preload.js";

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
  test("returns every channel id, with defaults for unconfigured channels", async () => {
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
    expect(body.policies).toHaveLength(CHANNEL_IDS.length);
    for (const p of body.policies) {
      expect(p.policy).toBe(ADMISSION_POLICY_DEFAULT);
      expect(p.note).toBeNull();
      expect(p.updatedAt).toBeNull();
    }
    const seen = new Set(body.policies.map((p) => p.channelType));
    for (const channel of CHANNEL_IDS) {
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
    expect(body.policies).toHaveLength(CHANNEL_IDS.length);
    const tg = body.policies.find((p) => p.channelType === "telegram");
    expect(tg?.policy).toBe("no_one");
    expect(tg?.note).toBe("off");
    expect(tg?.updatedAt).toBeGreaterThan(0);

    const phone = body.policies.find((p) => p.channelType === "phone");
    expect(phone?.policy).toBe(ADMISSION_POLICY_DEFAULT);
    expect(phone?.updatedAt).toBeNull();
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
});
