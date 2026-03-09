import { describe, expect, test } from "bun:test";

import { resolveVerificationSessionIntent } from "../daemon/verification-session-intent.js";

// =====================================================================
// 1. Direct guardian setup phrases => forced skill flow
// =====================================================================

describe("direct guardian setup phrases trigger forced routing", () => {
  const directSetupPhrases = [
    "help me confirm myself as your guardian by phone",
    "verify me as guardian",
    "verify me as your guardian",
    "confirm me as guardian",
    "confirm me as your guardian",
    "set me as guardian for voice",
    "set me as guardian for telegram",
    "set me up as guardian",
    "set me up as your guardian",
    "set up guardian verification",
    "setup guardian verification",
    "guardian verification setup",
    "please verify me as guardian",
    "can you verify me as guardian",
    "I want to become your guardian",
    "register me as your guardian",
    "I need to set myself as guardian",
    "guardian verify",
  ];

  for (const phrase of directSetupPhrases) {
    test(`"${phrase}" => direct_setup`, () => {
      const result = resolveVerificationSessionIntent(phrase);
      expect(result.kind).toBe("direct_setup");
      if (result.kind === "direct_setup") {
        expect(result.rewrittenContent).toContain("guardian-verify-setup");
        expect(result.rewrittenContent).toContain("skill_load");
      }
    });
  }
});

// =====================================================================
// 2. Conceptual / security questions => no forced routing
// =====================================================================

describe("conceptual questions do NOT trigger forced routing", () => {
  const conceptualPhrases = [
    "why can't you verify over phone?",
    "what is guardian verification?",
    "how does guardian verification work?",
    "explain guardian verification to me",
    "tell me about the guardian system",
    "why do I need to be a guardian?",
    "what does a guardian do?",
    "how do I become a guardian? explain the process",
    "is there a way to skip verification?",
    "can you tell me about verification channels?",
    "when was guardian verification added?",
    "who can be a guardian?",
  ];

  for (const phrase of conceptualPhrases) {
    test(`"${phrase}" => none`, () => {
      const result = resolveVerificationSessionIntent(phrase);
      expect(result.kind).toBe("none");
    });
  }
});

// =====================================================================
// 3. Non-guardian unrelated messages => unchanged
// =====================================================================

describe("non-guardian messages are not intercepted", () => {
  const unrelatedPhrases = [
    "what is the weather today?",
    "help me write an email",
    "set a reminder for 3pm",
    "open Chrome and search for cats",
    "record my screen",
    "tell me a joke",
    "create a new task",
    "schedule a meeting for tomorrow",
    "send a message to John",
    "",
  ];

  for (const phrase of unrelatedPhrases) {
    test(`"${phrase}" => none`, () => {
      const result = resolveVerificationSessionIntent(phrase);
      expect(result.kind).toBe("none");
    });
  }
});

// =====================================================================
// 4. Ambiguous verify phrases without guardian context => no forced routing
// =====================================================================

describe("ambiguous verify phrases without guardian context do NOT trigger forced routing", () => {
  const ambiguousPhrases = [
    "verify my phone number",
    "verify my phone",
    "verify my Telegram account",
    "verify voice channel",
  ];

  for (const phrase of ambiguousPhrases) {
    test(`"${phrase}" => none`, () => {
      const result = resolveVerificationSessionIntent(phrase);
      expect(result.kind).toBe("none");
    });
  }
});

// =====================================================================
// 5. Slash commands are never intercepted
// =====================================================================

describe("slash commands are never intercepted", () => {
  const slashCommands = [
    "/guardian-verify-setup",
    "/model opus",
    "/status",
    "/commands",
  ];

  for (const cmd of slashCommands) {
    test(`"${cmd}" => none`, () => {
      const result = resolveVerificationSessionIntent(cmd);
      expect(result.kind).toBe("none");
    });
  }
});

// =====================================================================
// 6. Channel hint extraction
// =====================================================================

describe("channel hint extraction", () => {
  test("unsupported channel keyword triggers setup but yields no channel hint", () => {
    const result = resolveVerificationSessionIntent(
      "set me as guardian for text",
    );
    expect(result.kind).toBe("direct_setup");
    if (result.kind === "direct_setup") {
      // "text" matches the guardian setup pattern but is not a supported
      // channel, so no channel hint is extracted.
      expect(result.channelHint).toBeUndefined();
    }
  });

  test("detects voice channel hint", () => {
    const result = resolveVerificationSessionIntent(
      "set me as guardian for voice",
    );
    expect(result.kind).toBe("direct_setup");
    if (result.kind === "direct_setup") {
      expect(result.channelHint).toBe("phone");
      expect(result.rewrittenContent).toContain("phone channel");
    }
  });

  test("detects Telegram channel hint", () => {
    const result = resolveVerificationSessionIntent(
      "set me as guardian for telegram",
    );
    expect(result.kind).toBe("direct_setup");
    if (result.kind === "direct_setup") {
      expect(result.channelHint).toBe("telegram");
      expect(result.rewrittenContent).toContain("telegram channel");
    }
  });

  test("no channel hint when unspecified", () => {
    const result = resolveVerificationSessionIntent("verify me as guardian");
    expect(result.kind).toBe("direct_setup");
    if (result.kind === "direct_setup") {
      expect(result.channelHint).toBeUndefined();
    }
  });
});
