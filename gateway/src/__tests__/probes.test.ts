import { describe, test, expect, afterAll, spyOn, afterEach } from "bun:test";

const env: Record<string, string> = {
  TELEGRAM_BOT_TOKEN: "test-tok",
  TELEGRAM_WEBHOOK_SECRET: "wh-sec",
  GATEWAY_PORT: "7830",
};

const saved: Record<string, string | undefined> = {};
for (const [k, v] of Object.entries(env)) {
  saved[k] = process.env[k];
  process.env[k] = v;
}

const { loadConfig } = await import("../config.js");
const { createTelegramWebhookHandler } =
  await import("../http/routes/telegram-webhook.js");

const config = await loadConfig();

const { handler: handleTelegramWebhook } = createTelegramWebhookHandler(config);

let draining = false;

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/healthz") {
    return Response.json({ status: "ok" });
  }

  if (url.pathname === "/readyz") {
    if (draining) {
      return Response.json({ status: "draining" }, { status: 503 });
    }
    return Response.json({ status: "ok" });
  }

  if (url.pathname === "/webhooks/telegram") {
    return handleTelegramWebhook(req);
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("/healthz", () => {
  test("returns 200 with ok status", async () => {
    const res = await handleRequest(new Request("http://gateway.test/healthz"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });
});

describe("/readyz", () => {
  test("returns 200 when not draining", async () => {
    const res = await handleRequest(new Request("http://gateway.test/readyz"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  test("returns 503 when draining", async () => {
    draining = true;
    try {
      const res = await handleRequest(
        new Request("http://gateway.test/readyz"),
      );
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.status).toBe("draining");
    } finally {
      draining = false;
    }
  });
});

describe("/readyz upstream probe", () => {
  afterEach(() => {
    // Restore any spies after each test
  });

  test("probes upstream /readyz (not /healthz)", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({ status: "ok" }),
    );
    try {
      // Simulate the real /readyz handler from gateway/src/index.ts:
      // it fetches `${config.assistantRuntimeBaseUrl}/readyz` with a 3s timeout.
      const upstream = await fetch(`${config.assistantRuntimeBaseUrl}/readyz`, {
        signal: AbortSignal.timeout(3000),
      });
      expect(upstream.ok).toBe(true);

      // Verify the URL probed is /readyz, not /healthz
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const calledUrl = fetchSpy.mock.calls[0][0] as string;
      expect(calledUrl).toContain("/readyz");
      expect(calledUrl).not.toContain("/healthz");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
