import { describe, expect, test } from "bun:test";

import {
  findDuplicateCandidate,
  isLikelyDuplicate,
} from "@/domains/contacts/duplicate-suggestion";
import type { ContactPayload } from "@/domains/contacts/types";

let nextId = 0;

function makeContact(
  overrides: Partial<ContactPayload> & { displayName: string },
): ContactPayload {
  nextId += 1;
  return {
    id: `contact-${nextId}`,
    role: "contact",
    notes: null,
    contactType: "human",
    interactionCount: 0,
    createdAt: 0,
    updatedAt: 0,
    channels: [],
    ...overrides,
  } as ContactPayload;
}

function withEmail(displayName: string, address: string): ContactPayload {
  const contact = makeContact({ displayName });
  contact.channels = [
    {
      id: `${contact.id}-email`,
      contactId: contact.id,
      type: "email",
      address,
      isPrimary: false,
      externalUserId: address,
      lastSeenAt: null,
      interactionCount: 0,
      lastInteraction: null,
      status: "active",
    } as ContactPayload["channels"][number],
  ];
  return contact;
}

describe("isLikelyDuplicate", () => {
  test("matches same display name case/whitespace-insensitively", () => {
    expect(
      isLikelyDuplicate(
        makeContact({ displayName: "Alice  Smith" }),
        makeContact({ displayName: "alice smith" }),
      ),
    ).toBe(true);
  });

  test("does not match generic placeholder names", () => {
    expect(
      isLikelyDuplicate(
        makeContact({ displayName: "New Contact" }),
        makeContact({ displayName: "New Contact" }),
      ),
    ).toBe(false);
  });

  test("matches same email root across dots and +suffixes", () => {
    expect(
      isLikelyDuplicate(
        withEmail("Alice Smith", "alice.smith@example.com"),
        withEmail("A. Smith (work)", "alicesmith+news@example.org"),
      ),
    ).toBe(true);
  });

  test("matches an email-address display name against an email channel", () => {
    expect(
      isLikelyDuplicate(
        makeContact({ displayName: "alice.smith@example.com" }),
        withEmail("Ally", "alicesmith@example.org"),
      ),
    ).toBe(true);
  });

  test("matches full-name slug against the other contact's email root", () => {
    expect(
      isLikelyDuplicate(
        makeContact({ displayName: "Alice Smith" }),
        withEmail("asmith", "alice.smith@example.com"),
      ),
    ).toBe(true);
  });

  test("does not match a bare first name against an email root", () => {
    expect(
      isLikelyDuplicate(
        makeContact({ displayName: "Alice" }),
        withEmail("someone", "alice@example.com"),
      ),
    ).toBe(false);
  });

  test("does not match unrelated contacts", () => {
    expect(
      isLikelyDuplicate(
        withEmail("Alice Smith", "alice.smith@example.com"),
        withEmail("Bob Jones", "bob.jones@example.com"),
      ),
    ).toBe(false);
  });

  test("ignores revoked email channels", () => {
    const revoked = withEmail("Someone Else", "alice.smith@example.com");
    revoked.channels = revoked.channels.map((ch) => ({
      ...ch,
      status: "revoked",
    }));
    expect(
      isLikelyDuplicate(withEmail("Ally", "alicesmith@example.org"), revoked),
    ).toBe(false);
  });
});

describe("findDuplicateCandidate", () => {
  test("returns the first matching candidate", () => {
    const contact = makeContact({ displayName: "Alice Smith" });
    const other = makeContact({ displayName: "Bob Jones" });
    const dupe = makeContact({ displayName: "Alice Smith" });
    expect(findDuplicateCandidate(contact, [other, dupe])).toBe(dupe);
  });

  test("never suggests guardians or assistant contacts", () => {
    const contact = makeContact({ displayName: "Alice Smith" });
    const guardian = makeContact({
      displayName: "Alice Smith",
      role: "guardian",
    });
    const assistant = makeContact({
      displayName: "Alice Smith",
      contactType: "assistant",
    });
    expect(findDuplicateCandidate(contact, [guardian, assistant])).toBeNull();
  });

  test("never suggests the contact itself", () => {
    const contact = makeContact({ displayName: "Alice Smith" });
    expect(findDuplicateCandidate(contact, [contact])).toBeNull();
  });
});
