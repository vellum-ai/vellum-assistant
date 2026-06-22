import { describe, expect, test } from "bun:test";

import { parseAccessRequestPayload } from "../notifications/access-request-copy.js";
import { buildApprovalNotificationBlocks } from "../notifications/adapters/slack.js";
import type { ChannelDeliveryPayload } from "../notifications/types.js";
import type { ApprovalUIMetadata } from "../runtime/channel-approval-types.js";

/**
 * Pins the Slack approval-card block contract: the title, identity subtitle,
 * quoted-preview body, action callback ids, source/permalink and requester-id
 * context blocks, the security-warning context block, and guardian
 * verification note that `buildApprovalNotificationBlocks` emits for an
 * access request.
 */

const APPROVAL: ApprovalUIMetadata = {
  requestId: "req-123",
  actions: [
    { id: "approve_once", label: "Approve once" },
    { id: "reject", label: "Reject" },
  ],
  plainTextFallback: 'Reply "ABC123 approve" or "ABC123 reject"',
};

function buildPayload(
  raw: Record<string, unknown>,
  approval: ApprovalUIMetadata = APPROVAL,
): ChannelDeliveryPayload {
  return {
    sourceEventName: "ingress.access_request",
    copy: { title: "Access Request", body: "Someone is requesting access" },
    urgency: "high",
    approvalContext: approval,
    accessRequestContext: parseAccessRequestPayload(raw),
  };
}

type Block = Record<string, unknown>;

function card(blocks: unknown[]): Block {
  const c = (blocks as Block[]).find((b) => b.type === "card");
  if (!c) throw new Error("no card block");
  return c;
}

function contextTexts(blocks: unknown[]): string[] {
  return (blocks as Block[])
    .filter((b) => b.type === "context")
    .map((b) => {
      const elements = b.elements as Array<{ text: string }>;
      return elements.map((e) => e.text).join("");
    });
}

function text(node: unknown): string {
  return (node as { text: string }).text;
}

const BASE: Record<string, unknown> = {
  requestId: "req-123",
  requestCode: "ABC123",
  sourceChannel: "slack",
  conversationExternalId: "C01ABC",
  actorExternalId: "U999",
  actorDisplayName: "Alice",
  actorUsername: "alice",
  senderIdentifier: "U999",
  messagePreview: "Hello, I need help with something",
  messageTs: "1700000000.000100",
};

describe("Slack access-request card blocks", () => {
  test("card carries title, identity subtitle, and quoted preview body", () => {
    const c = card(buildApprovalNotificationBlocks(buildPayload(BASE), "msg"));
    expect(text(c.title)).toBe("Access Request");
    expect(text(c.subtitle)).toBe("Alice (@alice) via slack");
    expect(text(c.body)).toBe('> _"Hello, I need help with something"_');
  });

  test("card actions encode the apr:<requestId>:<action> callback ids", () => {
    const c = card(buildApprovalNotificationBlocks(buildPayload(BASE), "msg"));
    const actions = c.actions as Array<Record<string, unknown>>;
    expect(actions).toHaveLength(2);
    expect(actions[0].action_id).toBe("apr:req-123:approve_once");
    expect(actions[0].style).toBe("primary");
    expect(actions[1].action_id).toBe("apr:req-123:reject");
    expect(actions[1].style).toBe("danger");
  });

  test("source context renders a channel mention with permalink", () => {
    const texts = contextTexts(
      buildApprovalNotificationBlocks(buildPayload(BASE), "msg"),
    );
    expect(texts).toContain(
      "Source: Slack — <#C01ABC> · <https://slack.com/archives/C01ABC/p1700000000000100|View message>",
    );
  });

  test("DM source renders as Direct message", () => {
    const blocks = buildApprovalNotificationBlocks(
      buildPayload({ ...BASE, conversationExternalId: "D01XYZ" }),
      "msg",
    );
    expect(contextTexts(blocks)).toContain(
      "Source: Slack — Direct message · <https://slack.com/archives/D01XYZ/p1700000000000100|View message>",
    );
  });

  test("requester id block appears when external id adds info", () => {
    const texts = contextTexts(
      buildApprovalNotificationBlocks(buildPayload(BASE), "msg"),
    );
    expect(texts).toContain("ID: U999");
  });

  test("invite directive context block is always present", () => {
    const texts = contextTexts(
      buildApprovalNotificationBlocks(buildPayload(BASE), "msg"),
    );
    expect(texts).toContain(
      'Reply "open invite flow" to start Trusted Contacts invite flow.',
    );
  });

  test("warnings render in a context block under the card", () => {
    const blocks = buildApprovalNotificationBlocks(
      buildPayload({
        ...BASE,
        isStranger: true,
        isRestricted: true,
        previousMemberStatus: "revoked",
      }),
      "msg",
    );
    // `subtext` is not a Slack card field; warnings must live in a real block
    // or Slack drops them and the guardian never sees them.
    expect(card(blocks).subtext).toBeUndefined();
    const warning = contextTexts(blocks).find((t) => t.includes(":warning:"));
    expect(warning).toBeDefined();
    expect(warning).toContain(":warning: This user was previously revoked.");
    expect(warning).toContain(
      ":warning: External Slack user (not in this workspace).",
    );
    expect(warning).toContain(":warning: Guest / restricted account.");
  });

  test("no warning context block when there are no warnings", () => {
    const blocks = buildApprovalNotificationBlocks(buildPayload(BASE), "msg");
    expect(card(blocks).subtext).toBeUndefined();
    expect(contextTexts(blocks).some((t) => t.includes(":warning:"))).toBe(
      false,
    );
  });

  test("body falls back to a default label when no preview", () => {
    const c = card(
      buildApprovalNotificationBlocks(
        buildPayload({ ...BASE, messagePreview: undefined }),
        "msg",
      ),
    );
    expect(text(c.body)).toBe("Requesting access to the assistant");
  });

  test("guardian verification note appears for fallback guardian resolution", () => {
    const texts = contextTexts(
      buildApprovalNotificationBlocks(
        buildPayload({ ...BASE, guardianResolutionSource: "vellum-anchor" }),
        "msg",
      ),
    );
    expect(
      texts.some((t) => t.includes("haven't verified your identity on slack")),
    ).toBe(true);
  });
});

/**
 * Pins the Slack tool-approval card: the assistant-as-actor subtitle, the
 * preview + command body, the action callback ids, and the source/permalink
 * context block — all driven by the shared view model from `contextPayload`.
 */
const TOOL_CTX: Record<string, unknown> = {
  requestId: "req-123",
  requestCode: "ABC123",
  requestKind: "tool_grant_request",
  toolName: "web_fetch",
  questionText: "ignored — the card recomposes from structured facts",
  sourceChannel: "slack",
  requesterIdentifier: "Noa Flaherty",
  conversationExternalId: "C01ABC",
  channelName: "general",
  messageTs: "1700000000.000100",
  messagePreview: "can you pull this?",
  commandPreview: "GET https://example.com",
};

function buildToolPayload(
  contextPayload: Record<string, unknown>,
  approval: ApprovalUIMetadata = APPROVAL,
): ChannelDeliveryPayload {
  return {
    sourceEventName: "guardian.question",
    copy: { title: "Tool approval", body: "msg" },
    urgency: "high",
    approvalContext: approval,
    contextPayload,
  };
}

describe("Slack tool-approval card blocks", () => {
  test("card title is generic; subtitle is the assistant-as-actor sentence", () => {
    const c = card(
      buildApprovalNotificationBlocks(buildToolPayload(TOOL_CTX), "msg"),
    );
    expect(text(c.title)).toBe("Tool approval");
    expect(text(c.subtitle)).toBe(
      'Assistant wants to use "web_fetch" in response to Noa Flaherty\'s message in #general.',
    );
  });

  test("body shows the requester's words and the redacted command", () => {
    const c = card(
      buildApprovalNotificationBlocks(buildToolPayload(TOOL_CTX), "msg"),
    );
    const body = text(c.body);
    expect(body).toContain('> _"can you pull this?"_');
    expect(body).toContain("Will run: `GET https://example.com`");
  });

  test("actions encode the apr:<requestId>:<action> callback ids", () => {
    const c = card(
      buildApprovalNotificationBlocks(buildToolPayload(TOOL_CTX), "msg"),
    );
    const actions = c.actions as Array<Record<string, unknown>>;
    expect(actions).toHaveLength(2);
    expect(actions[0].action_id).toBe("apr:req-123:approve_once");
    expect(actions[1].action_id).toBe("apr:req-123:reject");
    expect(actions[1].style).toBe("danger");
  });

  test("source context renders the channel mention + exact-message permalink", () => {
    const texts = contextTexts(
      buildApprovalNotificationBlocks(buildToolPayload(TOOL_CTX), "msg"),
    );
    expect(texts).toContain(
      "Source: Slack — <#C01ABC> · <https://slack.com/archives/C01ABC/p1700000000000100|View in Slack →>",
    );
  });

  test("DM source drops the channel and reads Direct message", () => {
    const texts = contextTexts(
      buildApprovalNotificationBlocks(
        buildToolPayload({
          ...TOOL_CTX,
          conversationExternalId: "D01XYZ",
          channelName: undefined,
        }),
        "msg",
      ),
    );
    expect(
      texts.some(
        (t) =>
          t.startsWith("Source: Slack — Direct message") &&
          t.includes("View in Slack →"),
      ),
    ).toBe(true);
  });

  test("no inbound trigger: title only, no source context block", () => {
    const blocks = buildApprovalNotificationBlocks(
      buildToolPayload({
        requestId: "req-self",
        requestCode: "AAA111",
        requestKind: "tool_approval",
        toolName: "bash",
        questionText: "ignored",
      }),
      "msg",
    );
    expect(text(card(blocks).subtitle)).toBe('Assistant wants to use "bash".');
    expect(contextTexts(blocks).some((t) => t.startsWith("Source:"))).toBe(
      false,
    );
  });
});
