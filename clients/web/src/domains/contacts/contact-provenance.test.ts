import { describe, expect, test } from "bun:test";

import { channelLinkProvenance } from "@/domains/contacts/channel-linking";
import { contactProvenanceLine } from "@/domains/contacts/contact-provenance";
import type { ContactChannelPayload } from "@/domains/contacts/types";

const JUL_7_2026 = Date.UTC(2026, 6, 7, 12);

function slackChannel(
  overrides: Partial<ContactChannelPayload>,
): ContactChannelPayload {
  return {
    id: "ch-1",
    contactId: "contact-1",
    type: "slack",
    address: "U0EXAMPLE01",
    isPrimary: false,
    externalUserId: "U0EXAMPLE01",
    lastSeenAt: null,
    interactionCount: 0,
    lastInteraction: null,
    ...overrides,
  } as ContactChannelPayload;
}

describe("channelLinkProvenance", () => {
  test("manual verification reads as guardian_linked", () => {
    expect(
      channelLinkProvenance({
        status: "active",
        verifiedAt: JUL_7_2026,
        verifiedVia: "manual",
      }),
    ).toBe("guardian_linked");
  });

  test("challenge and invite verification read as handshake", () => {
    for (const verifiedVia of ["challenge", "invite", null]) {
      expect(
        channelLinkProvenance({
          status: "active",
          verifiedAt: JUL_7_2026,
          verifiedVia,
        }),
      ).toBe("handshake");
    }
  });

  test("unverified channels have no provenance", () => {
    expect(
      channelLinkProvenance({
        status: "unverified",
        verifiedAt: null,
        verifiedVia: null,
      }),
    ).toBeNull();
  });
});

describe("contactProvenanceLine", () => {
  test("guardian_linked line uses the roster handle when cached", () => {
    const contact = {
      channels: [
        slackChannel({
          status: "active",
          verifiedAt: JUL_7_2026,
          verifiedVia: "manual",
        }),
      ],
    };
    const roster = [
      {
        id: "U0EXAMPLE01",
        username: "alice",
        displayName: "Alice Smith",
        imageUrl: null,
      },
    ];
    expect(contactProvenanceLine(contact, { slack: roster })).toMatch(
      /^Linked to @alice via workspace roster · /,
    );
  });

  test("guardian_linked line falls back to the member ID without a roster", () => {
    const contact = {
      channels: [
        slackChannel({
          status: "active",
          verifiedAt: JUL_7_2026,
          verifiedVia: "manual",
        }),
      ],
    };
    expect(contactProvenanceLine(contact)).toMatch(
      /^Linked to U0EXAMPLE01 via workspace roster · /,
    );
  });

  test("handshake line reads as verified via intro card", () => {
    const contact = {
      channels: [
        slackChannel({
          status: "active",
          verifiedAt: JUL_7_2026,
          verifiedVia: "challenge",
        }),
      ],
    };
    expect(contactProvenanceLine(contact)).toMatch(
      /^Verified via intro card · /,
    );
  });

  test("no verified slack channel yields no line", () => {
    expect(
      contactProvenanceLine({
        channels: [
          slackChannel({
            status: "unverified",
            verifiedAt: null,
            verifiedVia: null,
          }),
        ],
      }),
    ).toBeNull();
  });
});
