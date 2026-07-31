import { describe, expect, test } from "bun:test";

import {
  buildAccessRequestCardView,
  buildAccessRequestContractText,
  parseAccessRequestPayload,
} from "../notifications/access-request-copy.js";

function view(raw: Record<string, unknown>) {
  return buildAccessRequestCardView(parseAccessRequestPayload(raw));
}

const TAB = String.fromCharCode(9);

describe("buildAccessRequestCardView", () => {
  test("prefers actorDisplayName, falls back to senderIdentifier then 'Someone'", () => {
    expect(
      view({ actorDisplayName: "Alice", senderIdentifier: "U999" }).displayName,
    ).toBe("Alice");
    expect(view({ senderIdentifier: "U999" }).displayName).toBe("U999");
    expect(view({}).displayName).toBe("Someone");
  });

  test("sanitizes identity fields (strips control characters)", () => {
    const v = view({
      actorDisplayName: `Al${TAB}ice`,
      actorUsername: `a${TAB}lice`,
      actorExternalId: `U9${TAB}99`,
    });
    expect(v.displayName).toBe("Al ice");
    expect(v.username).toBe("a lice");
    expect(v.externalId).toBe("U9 99");
  });

  test("username and externalId are undefined when absent", () => {
    const v = view({ actorDisplayName: "Alice" });
    expect(v.username).toBeUndefined();
    expect(v.externalId).toBeUndefined();
  });

  test("detects Slack DM conversations", () => {
    expect(
      view({ sourceChannel: "slack", conversationExternalId: "D01XYZ" })
        .isSlackDm,
    ).toBe(true);
    expect(
      view({ sourceChannel: "slack", conversationExternalId: "C01ABC" })
        .isSlackDm,
    ).toBe(false);
    expect(
      view({ sourceChannel: "telegram", conversationExternalId: "D01XYZ" })
        .isSlackDm,
    ).toBe(false);
  });

  test("builds a Slack permalink only with slack source + conversation + ts", () => {
    expect(
      view({
        sourceChannel: "slack",
        conversationExternalId: "C01ABC",
        messageTs: "1700000000.000100",
      }).messagePermalink,
    ).toBe("https://slack.com/archives/C01ABC/p1700000000000100");
    expect(
      view({ sourceChannel: "slack", conversationExternalId: "C01ABC" })
        .messagePermalink,
    ).toBeUndefined();
    expect(
      view({
        sourceChannel: "telegram",
        conversationExternalId: "C01ABC",
        messageTs: "1.2",
      }).messagePermalink,
    ).toBeUndefined();
  });

  test("sanitizes message preview and yields undefined when blank after sanitizing", () => {
    expect(view({ messagePreview: "  hello  " }).messagePreview).toBe("hello");
    // Blank / control-character-only previews sanitize to empty → undefined
    // (no empty quote block is rendered downstream).
    expect(view({ messagePreview: "" }).messagePreview).toBeUndefined();
    expect(view({ messagePreview: "   " }).messagePreview).toBeUndefined();
    expect(view({}).messagePreview).toBeUndefined();
  });

  test("collects trust/security warnings", () => {
    const v = view({
      isStranger: true,
      isRestricted: true,
      previousMemberStatus: "revoked",
    });
    expect(v.warnings).toEqual([
      "This user was previously revoked.",
      "External Slack user (not in this workspace).",
      "Guest / restricted account.",
    ]);
    expect(view({}).warnings).toEqual([]);
  });
});

describe("admitted-mode introduction nudge copy", () => {
  test("view.admitted reflects the trigger marker", () => {
    expect(view({ trigger: "admitted" }).admitted).toBe(true);
    expect(view({}).admitted).toBe(false);
    expect(view({ trigger: "denied" }).admitted).toBe(false);
  });

  test("contract identity line branches on the trigger", () => {
    const base = {
      actorDisplayName: "Alice",
      senderIdentifier: "Alice",
      sourceChannel: "telegram",
    };
    expect(buildAccessRequestContractText(base)).toContain(
      "is requesting access to the assistant.",
    );
    const admitted = buildAccessRequestContractText({
      ...base,
      trigger: "admitted",
    });
    expect(admitted).toContain("messaged the assistant and was admitted");
    expect(admitted).not.toContain("is requesting access");
  });

  test("admitted contract text keeps the decision directives", () => {
    const text = buildAccessRequestContractText({
      actorDisplayName: "Alice",
      sourceChannel: "telegram",
      requestCode: "ab12cd",
      trigger: "admitted",
    });
    expect(text).toContain('"AB12CD trust"');
    expect(text).toContain('"AB12CD reject"');
    expect(text).toContain('"AB12CD block"');
  });
});
