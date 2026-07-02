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
 * access request — plus the tool-approval card body/continuation split.
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
  if (!c) {
    throw new Error("no card block");
  }
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

const TOOL_APPROVAL: ApprovalUIMetadata = {
  requestId: "req-456",
  actions: [
    { id: "approve_once", label: "Approve once" },
    { id: "reject", label: "Reject" },
  ],
  plainTextFallback: 'Reply "ABC123 approve" or "ABC123 reject"',
  permissionDetails: {
    toolName: "bash",
    riskLevel: "medium",
    toolInput: { command: "ls /tmp" },
    requesterIdentifier: "Alice",
  },
};

function buildToolApprovalPayload(): ChannelDeliveryPayload {
  return {
    sourceEventName: "guardian.question",
    copy: { title: "Guardian Question", body: "Approve tool: bash" },
    urgency: "high",
    approvalContext: TOOL_APPROVAL,
  };
}

function sectionTexts(blocks: unknown[]): string[] {
  return (blocks as Block[])
    .filter((b) => b.type === "section")
    .map((b) => text(b.text));
}

describe("Slack tool-approval card blocks", () => {
  test("short message renders entirely in the card body with no companion section", () => {
    const message = "Alice is requesting approval to run: ls /tmp";
    const blocks = buildApprovalNotificationBlocks(
      buildToolApprovalPayload(),
      message,
    );
    expect(text(card(blocks).body)).toBe(message);
    expect(sectionTexts(blocks)).toHaveLength(0);
  });

  test("card carries tool title and tool/requester subtitle", () => {
    const c = card(
      buildApprovalNotificationBlocks(buildToolApprovalPayload(), "msg"),
    );
    expect(text(c.title)).toBe("Tool Approval");
    expect(text(c.subtitle)).toBe("bash — requested by Alice");
  });

  test("long message continues in a section without repeating the card body", () => {
    const message = Array.from(
      { length: 40 },
      (_, i) => `word${String(i).padStart(2, "0")}`,
    ).join(" "); // 279 chars of distinct words
    const blocks = buildApprovalNotificationBlocks(
      buildToolApprovalPayload(),
      message,
    );

    const body = text(card(blocks).body);
    expect(body.length).toBeLessThanOrEqual(200);
    expect(body.endsWith(" ↓")).toBe(true);

    const sections = sectionTexts(blocks);
    expect(sections).toHaveLength(1);
    const continuation = sections[0];

    // Body + continuation reassemble the full message with nothing repeated
    // and nothing lost — the guardian reads each word exactly once.
    const bodyWords = body.replace(/ ↓$/, "").split(" ");
    const continuationWords = continuation.replace(/^… /, "").split(" ");
    expect([...bodyWords, ...continuationWords].join(" ")).toBe(message);
  });

  test("split lands on a word boundary", () => {
    const message = `${"a".repeat(190)} ${"b".repeat(60)}`;
    const blocks = buildApprovalNotificationBlocks(
      buildToolApprovalPayload(),
      message,
    );
    expect(text(card(blocks).body)).toBe(`${"a".repeat(190)} ↓`);
    expect(sectionTexts(blocks)[0]).toBe(`… ${"b".repeat(60)}`);
  });
});
