import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { GatewayConfig } from "../config.js";

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
let fetchMock: ReturnType<typeof mock<FetchFn>> = mock(
  async () => new Response(),
);

mock.module("../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

const {
  createSlackDeliverHandler,
  buildApprovalBlocks,
  buildDecisionResultBlocks,
  buildSlackPermissionRequestBlocks,
} = await import("../http/routes/slack-deliver.js");

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const merged: GatewayConfig = {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    defaultAssistantId: undefined,
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: 20971520,
    maxAttachmentConcurrency: 3,
    maxWebhookPayloadBytes: 1048576,
    port: 7830,
    routingEntries: [],
    runtimeInitialBackoffMs: 500,
    runtimeMaxRetries: 2,
    runtimeProxyEnabled: false,
    runtimeProxyRequireAuth: false,
    runtimeTimeoutMs: 30000,
    shutdownDrainMs: 5000,
    telegramApiBaseUrl: "https://api.telegram.org",
    telegramBotToken: undefined,
    telegramDeliverAuthBypass: false,
    telegramInitialBackoffMs: 1000,
    telegramMaxRetries: 3,
    telegramTimeoutMs: 15000,
    telegramWebhookSecret: undefined,
    twilioAuthToken: undefined,
    twilioAccountSid: undefined,
    twilioPhoneNumber: undefined,
    smsDeliverAuthBypass: false,
    ingressPublicBaseUrl: undefined,
    unmappedPolicy: "reject",
    whatsappPhoneNumberId: undefined,
    whatsappAccessToken: undefined,
    whatsappAppSecret: undefined,
    whatsappWebhookVerifyToken: undefined,
    whatsappDeliverAuthBypass: false,
    whatsappTimeoutMs: 15000,
    whatsappMaxRetries: 3,
    whatsappInitialBackoffMs: 1000,
    slackChannelBotToken: "xoxb-test-bot-token",
    slackChannelAppToken: undefined,
    slackDeliverAuthBypass: true,
    trustProxy: false,
    ...overrides,
  } as GatewayConfig;
  return merged;
}

function makeRequest(
  body: unknown,
  headers?: Record<string, string>,
  queryString = "",
): Request {
  return new Request(`http://localhost:7830/deliver/slack${queryString}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

let fetchCalls: {
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
}[];

beforeEach(() => {
  fetchCalls = [];
  fetchMock = mock(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      let body: unknown;
      try {
        if (init?.body) body = JSON.parse(String(init.body));
      } catch {
        /* not JSON */
      }
      const headers: Record<string, string> = {};
      if (init?.headers) {
        const h = init.headers;
        if (h && typeof h === "object" && !Array.isArray(h)) {
          for (const [k, v] of Object.entries(h)) {
            headers[k.toLowerCase()] = v;
          }
        }
      }
      fetchCalls.push({ url, body, headers });

      // Slack API response
      if (url.includes("slack.com/api/chat.postMessage")) {
        return new Response(
          JSON.stringify({ ok: true, ts: "1700000000.000100" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (url.includes("slack.com/api/chat.update")) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    },
  );
});

describe("slack-deliver endpoint", () => {
  test("returns 401 when auth is required and missing", async () => {
    const handler = createSlackDeliverHandler(
      makeConfig({ slackDeliverAuthBypass: false }),
    );
    const req = makeRequest({ chatId: "C123", text: "hello" });
    const res = await handler(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  test("returns 200 with valid payload containing chatId and text", async () => {
    const handler = createSlackDeliverHandler(makeConfig());
    const req = makeRequest({ chatId: "C123", text: "hello" });
    const res = await handler(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Verify the Slack API was called with the correct payload
    const slackCall = fetchCalls.find((c) =>
      c.url.includes("chat.postMessage"),
    );
    expect(slackCall).toBeDefined();
    expect((slackCall!.body as any).channel).toBe("C123");
    expect((slackCall!.body as any).text).toBe("hello");
  });

  test("threadTs query param gets passed as thread_ts to Slack API", async () => {
    const handler = createSlackDeliverHandler(makeConfig());
    const req = makeRequest(
      { chatId: "C123", text: "reply in thread" },
      undefined,
      "?threadTs=1700000000.000050",
    );
    const res = await handler(req);
    expect(res.status).toBe(200);

    const slackCall = fetchCalls.find((c) =>
      c.url.includes("chat.postMessage"),
    );
    expect(slackCall).toBeDefined();
    expect((slackCall!.body as any).thread_ts).toBe("1700000000.000050");
  });

  test("returns 400 when chatId/to is missing", async () => {
    const handler = createSlackDeliverHandler(makeConfig());
    const req = makeRequest({ text: "hello" });
    const res = await handler(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("chatId is required");
  });

  test("returns 400 with 'not supported' message when attachments are provided", async () => {
    const handler = createSlackDeliverHandler(makeConfig());
    const req = makeRequest({
      chatId: "C123",
      text: "hello",
      attachments: [{ id: "att-1" }],
    });
    const res = await handler(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("not supported");
  });

  test("returns 503 when bot token is not configured", async () => {
    const handler = createSlackDeliverHandler(
      makeConfig({ slackChannelBotToken: undefined }),
    );
    const req = makeRequest({ chatId: "C123", text: "hello" });
    const res = await handler(req);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toContain("not configured");
  });

  test("accepts 'to' as alias for chatId", async () => {
    const handler = createSlackDeliverHandler(makeConfig());
    const req = makeRequest({ to: "C_TO_CHAN", text: "hello" });
    const res = await handler(req);
    expect(res.status).toBe(200);

    const slackCall = fetchCalls.find((c) =>
      c.url.includes("chat.postMessage"),
    );
    expect(slackCall).toBeDefined();
    expect((slackCall!.body as any).channel).toBe("C_TO_CHAN");
  });

  test("returns 400 when text is missing", async () => {
    const handler = createSlackDeliverHandler(makeConfig());
    const req = makeRequest({ chatId: "C123" });
    const res = await handler(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("text is required");
  });

  test("returns 400 for invalid JSON", async () => {
    const handler = createSlackDeliverHandler(makeConfig());
    const req = new Request("http://localhost:7830/deliver/slack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    const res = await handler(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid JSON");
  });

  test("returns 405 for GET requests", async () => {
    const handler = createSlackDeliverHandler(makeConfig());
    const req = new Request("http://localhost:7830/deliver/slack", {
      method: "GET",
    });
    const res = await handler(req);
    expect(res.status).toBe(405);
  });

  test("sends Authorization header with bot token to Slack API", async () => {
    const handler = createSlackDeliverHandler(
      makeConfig({ slackChannelBotToken: "xoxb-my-secret-token" }),
    );
    const req = makeRequest({ chatId: "C123", text: "hello" });
    await handler(req);

    const slackCall = fetchCalls.find((c) =>
      c.url.includes("chat.postMessage"),
    );
    expect(slackCall).toBeDefined();
    expect(slackCall!.headers!["authorization"]).toBe(
      "Bearer xoxb-my-secret-token",
    );
  });

  test("returns 502 when Slack API returns ok: false", async () => {
    fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({ ok: false, error: "channel_not_found" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });

    const handler = createSlackDeliverHandler(makeConfig());
    const req = makeRequest({ chatId: "C123", text: "hello" });
    const res = await handler(req);
    expect(res.status).toBe(502);
  });

  test("does not include thread_ts when threadTs query param is absent", async () => {
    const handler = createSlackDeliverHandler(makeConfig());
    const req = makeRequest({ chatId: "C123", text: "hello" });
    await handler(req);

    const slackCall = fetchCalls.find((c) =>
      c.url.includes("chat.postMessage"),
    );
    expect(slackCall).toBeDefined();
    expect((slackCall!.body as any).thread_ts).toBeUndefined();
  });

  test("sends Block Kit blocks when approval payload is present", async () => {
    const handler = createSlackDeliverHandler(makeConfig());
    const req = makeRequest({
      chatId: "C123",
      text: "Allow shell?",
      approval: {
        requestId: "req-abc",
        actions: [
          { id: "approve_once", label: "Approve once" },
          { id: "reject", label: "Reject" },
        ],
        plainTextFallback: "Reply yes or no.",
      },
    });
    const res = await handler(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; ts: string };
    expect(body.ok).toBe(true);
    expect(body.ts).toBe("1700000000.000100");

    const slackCall = fetchCalls.find((c) =>
      c.url.includes("chat.postMessage"),
    );
    expect(slackCall).toBeDefined();
    const slackBody = slackCall!.body as any;
    expect(slackBody.blocks).toBeDefined();
    expect(slackBody.blocks).toHaveLength(2);
    expect(slackBody.blocks[0].type).toBe("section");
    expect(slackBody.blocks[1].type).toBe("actions");
    expect(slackBody.blocks[1].elements).toHaveLength(2);
    expect(slackBody.blocks[1].elements[0].value).toBe(
      "apr:req-abc:approve_once",
    );
    expect(slackBody.blocks[1].elements[0].style).toBe("primary");
    expect(slackBody.blocks[1].elements[1].value).toBe("apr:req-abc:reject");
    expect(slackBody.blocks[1].elements[1].style).toBe("danger");
  });

  test("returns 400 when approval is present but requestId is missing", async () => {
    const handler = createSlackDeliverHandler(makeConfig());
    const req = makeRequest({
      chatId: "C123",
      text: "Allow shell?",
      approval: {
        actions: [{ id: "approve_once", label: "Approve once" }],
        plainTextFallback: "Reply yes or no.",
      },
    });
    const res = await handler(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("requestId");
  });

  test("returns 400 when approval actions is empty", async () => {
    const handler = createSlackDeliverHandler(makeConfig());
    const req = makeRequest({
      chatId: "C123",
      text: "Allow shell?",
      approval: {
        requestId: "req-abc",
        actions: [],
        plainTextFallback: "Reply yes or no.",
      },
    });
    const res = await handler(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("non-empty array");
  });

  test("uses chat.update when updateTs is provided", async () => {
    const handler = createSlackDeliverHandler(makeConfig());
    const req = makeRequest({
      chatId: "C123",
      text: "Allow shell?",
      updateTs: "1700000000.000100",
      decisionLabel: "Approved",
    });
    const res = await handler(req);
    expect(res.status).toBe(200);

    const updateCall = fetchCalls.find((c) => c.url.includes("chat.update"));
    expect(updateCall).toBeDefined();
    const updateBody = updateCall!.body as any;
    expect(updateBody.channel).toBe("C123");
    expect(updateBody.ts).toBe("1700000000.000100");
    expect(updateBody.blocks).toBeDefined();
    // Should have a section block and a context block with the decision label
    expect(updateBody.blocks[0].type).toBe("section");
    expect(updateBody.blocks[1].type).toBe("context");
    expect(updateBody.blocks[1].elements[0].text).toBe("Approved");
  });

  test("does not call chat.postMessage when updateTs is provided", async () => {
    const handler = createSlackDeliverHandler(makeConfig());
    const req = makeRequest({
      chatId: "C123",
      text: "Allow shell?",
      updateTs: "1700000000.000100",
    });
    await handler(req);

    const postCall = fetchCalls.find((c) => c.url.includes("chat.postMessage"));
    expect(postCall).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Block Kit builder unit tests
// ═══════════════════════════════════════════════════════════════════════════

describe("buildApprovalBlocks", () => {
  test("generates section and actions blocks with correct button values", () => {
    const blocks = buildApprovalBlocks("Allow shell?", {
      requestId: "req-123",
      actions: [
        { id: "approve_once", label: "Approve once" },
        { id: "approve_10m", label: "Allow 10 min" },
        { id: "approve_always", label: "Approve always" },
        { id: "reject", label: "Reject" },
      ],
      plainTextFallback: "Reply yes or no.",
    });

    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("section");
    expect((blocks[0].text as any).text).toBe("Allow shell?");

    const actions = blocks[1] as any;
    expect(actions.type).toBe("actions");
    expect(actions.block_id).toBe("approval_req-123");
    expect(actions.elements).toHaveLength(4);

    // Approve once gets primary style
    expect(actions.elements[0].value).toBe("apr:req-123:approve_once");
    expect(actions.elements[0].style).toBe("primary");
    expect(actions.elements[0].text.text).toBe("Approve once");

    // Approve 10m has no style override
    expect(actions.elements[1].value).toBe("apr:req-123:approve_10m");
    expect(actions.elements[1].style).toBeUndefined();

    // Approve always has no style override
    expect(actions.elements[2].value).toBe("apr:req-123:approve_always");
    expect(actions.elements[2].style).toBeUndefined();

    // Reject gets danger style
    expect(actions.elements[3].value).toBe("apr:req-123:reject");
    expect(actions.elements[3].style).toBe("danger");
  });
});

describe("buildDecisionResultBlocks", () => {
  test("replaces action blocks with context block showing decision", () => {
    const blocks = buildDecisionResultBlocks(
      "Allow shell?",
      "Approved by user",
    );

    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("section");
    expect((blocks[0].text as any).text).toBe("Allow shell?");
    expect(blocks[1].type).toBe("context");
    expect((blocks[1].elements as any[])[0].text).toBe("Approved by user");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Permission request Block Kit builder unit tests
// ═══════════════════════════════════════════════════════════════════════════

describe("buildSlackPermissionRequestBlocks", () => {
  test("renders header, tool info, arguments, context, and actions blocks", () => {
    const blocks = buildSlackPermissionRequestBlocks("Allow shell?", {
      requestId: "req-perm-1",
      actions: [
        { id: "approve_once", label: "Approve once" },
        { id: "reject", label: "Reject" },
      ],
      plainTextFallback: "Reply yes or no.",
      permissionDetails: {
        toolName: "shell",
        riskLevel: "high",
        toolInput: { command: "rm -rf /tmp/test" },
      },
    });

    expect(blocks).toHaveLength(5);

    // Header block
    expect(blocks[0].type).toBe("header");
    expect((blocks[0].text as any).text).toBe("Permission Request");

    // Tool info section with risk emoji
    expect(blocks[1].type).toBe("section");
    const toolText = (blocks[1].text as any).text as string;
    expect(toolText).toContain("`shell`");
    expect(toolText).toContain("high");
    // Red circle emoji for high risk
    expect(toolText).toContain("\u{1F534}");

    // Arguments section
    expect(blocks[2].type).toBe("section");
    const argsText = (blocks[2].text as any).text as string;
    expect(argsText).toContain("*Arguments*");
    expect(argsText).toContain("*command:*");
    expect(argsText).toContain("`rm -rf /tmp/test`");

    // Context block (no requester in this case)
    expect(blocks[3].type).toBe("context");
    const contextElements = blocks[3].elements as any[];
    // Only timestamp element when no requester
    expect(contextElements).toHaveLength(1);

    // Actions block
    expect(blocks[4].type).toBe("actions");
    expect(blocks[4].elements as any[]).toHaveLength(2);
    expect((blocks[4].elements as any[])[0].value).toBe(
      "apr:req-perm-1:approve_once",
    );
  });

  test("includes requester identifier in context block for guardian-escalated requests", () => {
    const blocks = buildSlackPermissionRequestBlocks("Allow deploy?", {
      requestId: "req-perm-2",
      actions: [
        { id: "approve_once", label: "Approve once" },
        { id: "reject", label: "Reject" },
      ],
      plainTextFallback: "Reply yes or no.",
      permissionDetails: {
        toolName: "deploy",
        riskLevel: "medium",
        toolInput: { target: "production" },
        requesterIdentifier: "alice",
      },
    });

    // Context block should have 2 elements: requester + timestamp
    const contextBlock = blocks.find((b) => b.type === "context") as any;
    expect(contextBlock).toBeDefined();
    expect(contextBlock.elements).toHaveLength(2);
    expect(contextBlock.elements[0].text).toContain("alice");
    expect(contextBlock.elements[0].text).toContain("Requested by");
  });

  test("uses correct risk emoji for each level", () => {
    const riskLevels = [
      { level: "low", emoji: "\u{1F7E2}" },
      { level: "medium", emoji: "\u{1F7E1}" },
      { level: "high", emoji: "\u{1F534}" },
    ];

    for (const { level, emoji } of riskLevels) {
      const blocks = buildSlackPermissionRequestBlocks("Allow tool?", {
        requestId: "req-risk",
        actions: [{ id: "approve_once", label: "Approve" }],
        plainTextFallback: "Reply yes or no.",
        permissionDetails: {
          toolName: "test_tool",
          riskLevel: level,
          toolInput: {},
        },
      });

      const toolSection = blocks[1] as any;
      expect(toolSection.text.text).toContain(emoji);
    }
  });

  test("shows 'No arguments' when tool input is empty", () => {
    const blocks = buildSlackPermissionRequestBlocks("Allow tool?", {
      requestId: "req-empty",
      actions: [{ id: "approve_once", label: "Approve" }],
      plainTextFallback: "Reply yes or no.",
      permissionDetails: {
        toolName: "read_file",
        riskLevel: "low",
        toolInput: {},
      },
    });

    const argsSection = blocks[2] as any;
    expect(argsSection.text.text).toContain("No arguments");
  });

  test("truncates long argument values", () => {
    const longValue = "x".repeat(300);
    const blocks = buildSlackPermissionRequestBlocks("Allow tool?", {
      requestId: "req-long",
      actions: [{ id: "approve_once", label: "Approve" }],
      plainTextFallback: "Reply yes or no.",
      permissionDetails: {
        toolName: "write_file",
        riskLevel: "medium",
        toolInput: { content: longValue },
      },
    });

    const argsSection = blocks[2] as any;
    const argsText = argsSection.text.text as string;
    expect(argsText.length).toBeLessThan(longValue.length);
    expect(argsText).toContain("...");
  });

  test("button styles match approval pattern (primary for approve, danger for reject)", () => {
    const blocks = buildSlackPermissionRequestBlocks("Allow tool?", {
      requestId: "req-styles",
      actions: [
        { id: "approve_once", label: "Approve once" },
        { id: "approve_10m", label: "Allow 10 min" },
        { id: "reject", label: "Reject" },
      ],
      plainTextFallback: "Reply yes or no.",
      permissionDetails: {
        toolName: "shell",
        riskLevel: "high",
        toolInput: {},
      },
    });

    const actionsBlock = blocks.find((b) => b.type === "actions") as any;
    expect(actionsBlock.elements[0].style).toBe("primary");
    expect(actionsBlock.elements[1].style).toBeUndefined();
    expect(actionsBlock.elements[2].style).toBe("danger");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Permission request integration tests (deliver handler)
// ═══════════════════════════════════════════════════════════════════════════

describe("slack-deliver with permission details", () => {
  test("uses rich permission blocks when permissionDetails is present in approval", async () => {
    const handler = createSlackDeliverHandler(makeConfig());
    const req = makeRequest({
      chatId: "C123",
      text: "Allow shell?",
      approval: {
        requestId: "req-perm-int",
        actions: [
          { id: "approve_once", label: "Approve once" },
          { id: "reject", label: "Reject" },
        ],
        plainTextFallback: "Reply yes or no.",
        permissionDetails: {
          toolName: "shell",
          riskLevel: "high",
          toolInput: { command: "ls -la" },
        },
      },
    });
    const res = await handler(req);
    expect(res.status).toBe(200);

    const slackCall = fetchCalls.find((c) =>
      c.url.includes("chat.postMessage"),
    );
    expect(slackCall).toBeDefined();
    const slackBody = slackCall!.body as any;
    expect(slackBody.blocks).toBeDefined();
    // Rich permission blocks: header, tool info, args, context, actions = 5
    expect(slackBody.blocks).toHaveLength(5);
    expect(slackBody.blocks[0].type).toBe("header");
    expect(slackBody.blocks[1].type).toBe("section");
    expect(slackBody.blocks[4].type).toBe("actions");
    expect(slackBody.blocks[4].elements[0].value).toBe(
      "apr:req-perm-int:approve_once",
    );
  });

  test("falls back to basic approval blocks when permissionDetails is absent", async () => {
    const handler = createSlackDeliverHandler(makeConfig());
    const req = makeRequest({
      chatId: "C123",
      text: "Allow shell?",
      approval: {
        requestId: "req-basic",
        actions: [
          { id: "approve_once", label: "Approve once" },
          { id: "reject", label: "Reject" },
        ],
        plainTextFallback: "Reply yes or no.",
      },
    });
    const res = await handler(req);
    expect(res.status).toBe(200);

    const slackCall = fetchCalls.find((c) =>
      c.url.includes("chat.postMessage"),
    );
    expect(slackCall).toBeDefined();
    const slackBody = slackCall!.body as any;
    // Basic approval blocks: section + actions = 2
    expect(slackBody.blocks).toHaveLength(2);
    expect(slackBody.blocks[0].type).toBe("section");
    expect(slackBody.blocks[1].type).toBe("actions");
  });
});
