import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ContactWithChannels } from "../contacts/types.js";

// ---------------------------------------------------------------------------
// Mock state for resolveCallHints tests
// ---------------------------------------------------------------------------

let mockAssistantName: string | null = "Nova";
let mockGuardianName: string = "Alex";
let mockTargetContact: ContactWithChannels | null = null;
let mockRecentContacts: ContactWithChannels[] = [];
let mockFindContactByAddressThrows = false;
let mockListContactsThrows = false;

const logWarnFn = mock(() => {});

// ---------------------------------------------------------------------------
// Mock modules — must be before importing module under test
// ---------------------------------------------------------------------------

mock.module("../daemon/identity-helpers.js", () => ({
  getAssistantName: () => mockAssistantName,
}));

mock.module("../prompts/user-reference.js", () => ({
  DEFAULT_USER_REFERENCE: "my human",
  resolveGuardianName: () => mockGuardianName,
}));

mock.module("../contacts/contact-store.js", () => ({
  findContactByAddress: (_type: string, _address: string) => {
    if (mockFindContactByAddressThrows) {
      throw new Error("DB error: findContactByAddress");
    }
    return mockTargetContact;
  },
  findGuardianForChannel: () => null,
  listGuardianChannels: () => null,
  listContacts: (_limit?: number) => {
    if (mockListContactsThrows) {
      throw new Error("DB error: listContacts");
    }
    return mockRecentContacts;
  },
}));

// Bun's mock.module for "../util/logger.js" doesn't intercept the transitive
// import in stt-hints.ts due to a Bun limitation. Mocking pino at the package
// level works because getLogger uses a Proxy that lazily creates a pino child
// logger — intercepting pino itself captures all log calls.
const mockChildLogger = {
  debug: () => {},
  info: () => {},
  warn: logWarnFn,
  error: () => {},
  child: () => mockChildLogger,
};
const mockPinoLogger = Object.assign(() => mockChildLogger, {
  destination: () => ({}),
  multistream: () => ({}),
});
mock.module("pino", () => ({ default: mockPinoLogger }));
mock.module("pino-pretty", () => ({ default: () => ({}) }));

// Import after mocking
import {
  buildSttHints,
  resolveCallHints,
  type SttHintsInput,
} from "../calls/stt-hints.js";

function emptyInput(): SttHintsInput {
  return {
    staticHints: [],
    assistantName: null,
    guardianName: null,
    taskDescription: null,
    targetContactName: null,
    callerContactName: null,
    inviteFriendName: null,
    inviteGuardianName: null,
    recentContactNames: [],
  };
}

describe("buildSttHints", () => {
  test("empty inputs produce empty string", () => {
    expect(buildSttHints(emptyInput())).toBe("");
  });

  test("static hints included verbatim", () => {
    const input = emptyInput();
    input.staticHints = ["Vellum", "Acme"];
    expect(buildSttHints(input)).toBe("Vellum,Acme");
  });

  test("assistant name included", () => {
    const input = emptyInput();
    input.assistantName = "Nova";
    expect(buildSttHints(input)).toBe("Nova");
  });

  test("guardian name included", () => {
    const input = emptyInput();
    input.guardianName = "Alex";
    expect(buildSttHints(input)).toBe("Alex");
  });

  test('default guardian name "my human" excluded', () => {
    const input = emptyInput();
    input.guardianName = "my human";
    expect(buildSttHints(input)).toBe("");
  });

  test("guardian name with whitespace around default sentinel excluded", () => {
    const input = emptyInput();
    input.guardianName = "  my human  ";
    expect(buildSttHints(input)).toBe("");
  });

  test("invite friend name included", () => {
    const input = emptyInput();
    input.inviteFriendName = "Alice";
    expect(buildSttHints(input)).toBe("Alice");
  });

  test("invite guardian name included", () => {
    const input = emptyInput();
    input.inviteGuardianName = "Bob";
    expect(buildSttHints(input)).toBe("Bob");
  });

  test("target contact name included", () => {
    const input = emptyInput();
    input.targetContactName = "Charlie";
    expect(buildSttHints(input)).toBe("Charlie");
  });

  test("caller contact name included", () => {
    const input = emptyInput();
    input.callerContactName = "Diana";
    expect(buildSttHints(input)).toBe("Diana");
  });

  test("recent contact names included", () => {
    const input = emptyInput();
    input.recentContactNames = ["Dave", "Eve"];
    expect(buildSttHints(input)).toBe("Dave,Eve");
  });

  test("proper nouns extracted from task description", () => {
    const input = emptyInput();
    input.taskDescription = "Call John Smith at Acme Corp";
    const result = buildSttHints(input);
    expect(result).toContain("John");
    expect(result).toContain("Smith");
    expect(result).toContain("Acme");
    expect(result).toContain("Corp");
    // "Call" is the first word of the sentence — should not be extracted
    expect(result).not.toContain("Call");
  });

  test("proper nouns extracted across sentence boundaries", () => {
    const input = emptyInput();
    input.taskDescription =
      "Meet with Alice. Then call Bob! Ask Charlie? Done.";
    const result = buildSttHints(input);
    expect(result).toContain("Alice");
    expect(result).toContain("Bob");
    expect(result).toContain("Charlie");
    // First words of sentences should be excluded
    expect(result).not.toContain("Meet");
    expect(result).not.toContain("Then");
    expect(result).not.toContain("Ask");
    expect(result).not.toContain("Done");
  });

  test("duplicates removed (case-insensitive)", () => {
    const input = emptyInput();
    input.staticHints = ["Vellum", "vellum", "VELLUM"];
    input.recentContactNames = ["Vellum"];
    const result = buildSttHints(input);
    // Should appear only once — the first occurrence is kept
    expect(result).toBe("Vellum");
  });

  test("empty and whitespace-only entries filtered", () => {
    const input = emptyInput();
    input.staticHints = ["", "  ", "Valid", " ", "Also Valid"];
    expect(buildSttHints(input)).toBe("Valid,Also Valid");
  });

  test("entries are trimmed", () => {
    const input = emptyInput();
    input.staticHints = ["  Padded  ", " Spaces "];
    expect(buildSttHints(input)).toBe("Padded,Spaces");
  });

  test("output truncated at MAX_HINTS_LENGTH without partial words", () => {
    const input = emptyInput();
    // Create hints that will exceed 500 chars when joined
    const longHints: string[] = [];
    for (let i = 0; i < 100; i++) {
      longHints.push(`Hint${i}LongWord`);
    }
    input.staticHints = longHints;
    const result = buildSttHints(input);
    expect(result.length).toBeLessThanOrEqual(500);
    // Should not end with a comma (that would indicate a truncation right after a separator)
    expect(result).not.toMatch(/,$/);
    // Every comma-separated part should be a complete hint from our input
    const parts = result.split(",");
    for (const part of parts) {
      expect(input.staticHints).toContain(part);
    }
  });

  test("all sources combined in correct order", () => {
    const input: SttHintsInput = {
      staticHints: ["StaticOne"],
      assistantName: "Nova",
      guardianName: "Alex",
      taskDescription: "Call John at Acme",
      targetContactName: "Target",
      callerContactName: "Caller",
      inviteFriendName: "Friend",
      inviteGuardianName: "Guardian",
      recentContactNames: ["Recent"],
    };
    const result = buildSttHints(input);
    const parts = result.split(",");
    // Verify all expected hints are present
    expect(parts).toContain("StaticOne");
    expect(parts).toContain("Nova");
    expect(parts).toContain("Alex");
    expect(parts).toContain("John");
    expect(parts).toContain("Acme");
    expect(parts).toContain("Target");
    expect(parts).toContain("Caller");
    expect(parts).toContain("Friend");
    expect(parts).toContain("Guardian");
    expect(parts).toContain("Recent");
  });

  test("surnames after abbreviation periods are preserved", () => {
    const input = emptyInput();
    input.taskDescription = "Call Dr. Smith at Acme";
    const result = buildSttHints(input);
    expect(result).toContain("Smith");
    expect(result).toContain("Acme");
    // "Dr" should also appear as a capitalized word
    expect(result).toContain("Dr");
  });

  test("multiple abbreviation titles preserve following names", () => {
    const input = emptyInput();
    input.taskDescription = "Meet Mr. Johnson and Mrs. Williams at the office";
    const result = buildSttHints(input);
    expect(result).toContain("Johnson");
    expect(result).toContain("Williams");
  });

  test("non-ASCII letters preserved in names", () => {
    const input = emptyInput();
    input.taskDescription = "Call José García and Łukasz Nowak";
    const result = buildSttHints(input);
    expect(result).toContain("José");
    expect(result).toContain("García");
    expect(result).toContain("Łukasz");
    expect(result).toContain("Nowak");
  });

  test("accented uppercase letters detected as proper nouns", () => {
    const input = emptyInput();
    input.taskDescription = "Talk to Zoë about the project";
    const result = buildSttHints(input);
    expect(result).toContain("Zoë");
  });

  test("null and empty string names are excluded", () => {
    const input = emptyInput();
    input.assistantName = "";
    input.guardianName = "";
    input.targetContactName = null;
    input.inviteFriendName = null;
    input.inviteGuardianName = null;
    expect(buildSttHints(input)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// resolveCallHints — wiring and error resilience
// ---------------------------------------------------------------------------

function makeContact(displayName: string): ContactWithChannels {
  const now = Date.now();
  return {
    id: `contact-${displayName.toLowerCase()}`,
    displayName,
    notes: null,
    lastInteraction: null,
    interactionCount: 0,
    createdAt: now,
    updatedAt: now,
    role: "contact",
    contactType: "human",
    principalId: null,
    userFile: null,
    channels: [],
  };
}

describe("resolveCallHints", () => {
  beforeEach(() => {
    mockAssistantName = "Nova";
    mockGuardianName = "Alex";
    mockTargetContact = null;
    mockRecentContacts = [];
    mockFindContactByAddressThrows = false;
    mockListContactsThrows = false;
    logWarnFn.mockClear();
  });

  test("happy path wires all sources correctly", () => {
    mockTargetContact = makeContact("Alice");
    mockRecentContacts = [makeContact("Bob"), makeContact("Charlie")];

    const session = {
      task: "Call Alice at Acme",
      toNumber: "+15551234567",
      fromNumber: "+15559876543",
      direction: "outbound" as const,
      inviteFriendName: "Dave",
      inviteGuardianName: "Eve",
    };

    const result = resolveCallHints(session, ["StaticHint"]);
    const parts = result.split(",");

    expect(parts).toContain("StaticHint");
    expect(parts).toContain("Nova");
    expect(parts).toContain("Alex");
    expect(parts).toContain("Alice");
    expect(parts).toContain("Dave");
    expect(parts).toContain("Eve");
    expect(parts).toContain("Bob");
    expect(parts).toContain("Charlie");
    // Proper nouns from task description
    expect(parts).toContain("Acme");
    expect(logWarnFn).not.toHaveBeenCalled();
  });

  test("findContactByAddress failure is caught and logged without throwing", () => {
    mockFindContactByAddressThrows = true;
    mockRecentContacts = [makeContact("Bob")];

    const session = {
      task: null,
      toNumber: "+15551234567",
      fromNumber: "+15559876543",
      direction: "outbound" as const,
      inviteFriendName: null,
      inviteGuardianName: null,
    };

    // Should not throw
    const result = resolveCallHints(session, []);
    const parts = result.split(",");

    // Target contact should be absent (lookup failed)
    // But other sources should still work
    expect(parts).toContain("Nova");
    expect(parts).toContain("Alex");
    expect(parts).toContain("Bob");
    expect(logWarnFn).toHaveBeenCalled();
  });

  test("listContacts failure is caught and logged without throwing", () => {
    mockListContactsThrows = true;
    mockTargetContact = makeContact("Alice");

    const session = {
      task: null,
      toNumber: "+15551234567",
      fromNumber: "+15559876543",
      direction: "outbound" as const,
      inviteFriendName: null,
      inviteGuardianName: null,
    };

    // Should not throw
    const result = resolveCallHints(session, []);
    const parts = result.split(",");

    // Recent contacts should be absent (listing failed)
    // But other sources should still work
    expect(parts).toContain("Nova");
    expect(parts).toContain("Alex");
    expect(parts).toContain("Alice");
    expect(logWarnFn).toHaveBeenCalled();
  });

  test("inbound call resolves caller contact from fromNumber", () => {
    mockTargetContact = makeContact("Alice");
    mockRecentContacts = [makeContact("Bob")];

    const session = {
      task: null,
      toNumber: "+15559876543",
      fromNumber: "+15551234567",
      direction: "inbound" as const,
      inviteFriendName: null,
      inviteGuardianName: null,
    };

    const result = resolveCallHints(session, []);
    const parts = result.split(",");

    // For inbound, the contact found via fromNumber should appear as caller, not target
    expect(parts).toContain("Alice");
    expect(parts).toContain("Nova");
    expect(parts).toContain("Alex");
    expect(parts).toContain("Bob");
    expect(logWarnFn).not.toHaveBeenCalled();
  });

  test("null session produces hints from assistant name, guardian name, and recent contacts", () => {
    mockRecentContacts = [makeContact("RecentOne"), makeContact("RecentTwo")];

    const result = resolveCallHints(null, ["Static"]);
    const parts = result.split(",");

    expect(parts).toContain("Static");
    expect(parts).toContain("Nova");
    expect(parts).toContain("Alex");
    expect(parts).toContain("RecentOne");
    expect(parts).toContain("RecentTwo");
    // No target contact lookup should have been attempted (no session)
    expect(logWarnFn).not.toHaveBeenCalled();
  });
});
