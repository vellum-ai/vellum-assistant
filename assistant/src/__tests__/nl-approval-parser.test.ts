import { describe, expect, test } from "bun:test";

import {
  type ApprovalIntent,
  parseApprovalIntent,
} from "../runtime/nl-approval-parser.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expectApproval(
  text: string,
  decision: ApprovalIntent["decision"],
): void {
  const result = parseApprovalIntent(text);
  expect(result).not.toBeNull();
  expect(result!.decision).toBe(decision);
  expect(result!.confidence).toBeGreaterThanOrEqual(0.9);
}

function expectNoIntent(text: string): void {
  const result = parseApprovalIntent(text);
  expect(result).toBeNull();
}

// ---------------------------------------------------------------------------
// Approval patterns
// ---------------------------------------------------------------------------

describe("parseApprovalIntent", () => {
  describe("approval phrases", () => {
    test.each([
      "yes",
      "yep",
      "yeah",
      "yea",
      "yup",
      "approved",
      "approve",
      "go ahead",
      "do it",
      "sure",
      "ok",
      "okay",
      "k",
      "lgtm",
      "sounds good",
      "go for it",
      "please",
      "pls",
      "y",
    ])("recognizes '%s' as approval", (phrase) => {
      expectApproval(phrase, "approve");
    });

    test("recognizes thumbs up emoji", () => {
      expectApproval("\u{1F44D}", "approve");
    });
  });

  // ---------------------------------------------------------------------------
  // Rejection patterns
  // ---------------------------------------------------------------------------

  describe("rejection phrases", () => {
    test.each([
      "no",
      "nope",
      "nah",
      "reject",
      "rejected",
      "denied",
      "deny",
      "don't",
      "dont",
      "cancel",
      "stop",
      "n",
    ])("recognizes '%s' as rejection", (phrase) => {
      expectApproval(phrase, "reject");
    });

    test("recognizes thumbs down emoji", () => {
      expectApproval("\u{1F44E}", "reject");
    });
  });

  // ---------------------------------------------------------------------------
  // Timed phrases — no longer recognized as a distinct decision type
  // ---------------------------------------------------------------------------

  describe("timed phrases (collapsed to approve)", () => {
    test.each([
      "approve for 10 minutes",
      "approve for 10 min",
      "approve for 10m",
      "yes for 10 minutes",
      "yes for 10 min",
      "ok for 10 minutes",
      "sure for 10 minutes",
      "go ahead for 10 minutes",
      "yep for 10 minutes",
      "yeah for 10 minutes",
      "approve 10m",
      "approve 10 min",
      "approve 10 minutes",
      "yes for now",
      "approve for now",
      "ok for now",
    ])("recognizes '%s' as approval (legacy timed phrase)", (phrase) => {
      expectApproval(phrase, "approve");
    });
  });

  // ---------------------------------------------------------------------------
  // Case insensitivity
  // ---------------------------------------------------------------------------

  describe("case insensitivity", () => {
    test.each(["YES", "Yes", "yEs", "APPROVE", "Approve", "LGTM", "Lgtm"])(
      "handles mixed case '%s'",
      (phrase) => {
        expectApproval(phrase, "approve");
      },
    );

    test.each(["NO", "No", "REJECT", "Reject", "CANCEL", "Cancel"])(
      "handles mixed case rejection '%s'",
      (phrase) => {
        expectApproval(phrase, "reject");
      },
    );

    test("handles 'Approve For 10 Minutes' as approval", () => {
      expectApproval("Approve For 10 Minutes", "approve");
    });
  });

  // ---------------------------------------------------------------------------
  // Whitespace and punctuation
  // ---------------------------------------------------------------------------

  describe("whitespace and punctuation", () => {
    test("trims leading/trailing whitespace", () => {
      expectApproval("  yes  ", "approve");
    });

    test("strips trailing period", () => {
      expectApproval("yes.", "approve");
    });

    test("strips trailing exclamation", () => {
      expectApproval("yes!", "approve");
    });

    test("strips trailing comma", () => {
      expectApproval("ok,", "approve");
    });

    test("strips trailing question mark", () => {
      expectApproval("ok?", "approve");
    });

    test("strips multiple trailing punctuation", () => {
      expectApproval("yes!!!", "approve");
    });

    test("collapses internal whitespace", () => {
      expectApproval("go   ahead", "approve");
    });

    test("handles trailing punctuation on rejection", () => {
      expectApproval("no.", "reject");
    });

    test("handles trailing punctuation on timed phrase as approval", () => {
      expectApproval("approve for 10 minutes.", "approve");
    });
  });

  // ---------------------------------------------------------------------------
  // Non-matching inputs (should return null)
  // ---------------------------------------------------------------------------

  describe("non-matching inputs", () => {
    test("returns null for empty string", () => {
      expectNoIntent("");
    });

    test("returns null for whitespace-only string", () => {
      expectNoIntent("   ");
    });

    test("returns null for unrelated message", () => {
      expectNoIntent("what is the weather today?");
    });

    test("does not match approval word inside a longer sentence", () => {
      expectNoIntent("yes but also do X");
    });

    test("does not match 'yes and can you also...'", () => {
      expectNoIntent("yes and can you also check the logs");
    });

    test("does not match approval word as substring of other words", () => {
      expectNoIntent("yesterday was a good day");
    });

    test("does not match 'no I meant something else'", () => {
      expectNoIntent("no I meant something else");
    });

    test("does not match a long message containing approval words", () => {
      expectNoIntent(
        "I think we should approve this after we review the changes",
      );
    });

    test("does not match a question about approval", () => {
      expectNoIntent("should I approve this?");
    });

    test("does not match multi-sentence messages", () => {
      expectNoIntent("ok. But also check the database.");
    });

    test("returns null for random text", () => {
      expectNoIntent("hello world");
    });

    test("returns null for numbers", () => {
      expectNoIntent("12345");
    });

    test("returns null for URLs", () => {
      expectNoIntent("https://example.com");
    });
  });

  // ---------------------------------------------------------------------------
  // Ref tag stripping
  // ---------------------------------------------------------------------------

  describe("ref tag stripping", () => {
    test("strips [ref:...] tag from approval", () => {
      expectApproval("yes [ref:abc123]", "approve");
    });

    test("strips [ref:...] tag from rejection", () => {
      expectApproval("no [ref:req-2]", "reject");
    });

    test("strips [ref:...] tag from emoji approval", () => {
      expectApproval("\u{1F44D} [ref:req-2]", "approve");
    });

    test("strips [ref:...] tag from timed phrase and returns approval", () => {
      expectApproval("approve for 10 minutes [ref:req-5]", "approve");
    });

    test("strips [ref:...] tag with mixed case", () => {
      expectApproval("Yes [ref:REQ-42]", "approve");
    });

    test("handles [ref:...] tag with no space before it", () => {
      expectApproval("ok[ref:abc]", "approve");
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe("edge cases", () => {
    test("single character 'y' is approval", () => {
      expectApproval("y", "approve");
    });

    test("single character 'n' is rejection", () => {
      expectApproval("n", "reject");
    });

    test("does not match 'yes please do X' (has additional content)", () => {
      expectNoIntent("yes please do something else too");
    });

    test("matches 'please' alone as approval", () => {
      expectApproval("please", "approve");
    });

    test("does not match numeric-only strings as approval", () => {
      expectNoIntent("10");
    });

    test("rejects very long strings even if they start with approval", () => {
      expectNoIntent("yes ".repeat(20));
    });
  });
});
