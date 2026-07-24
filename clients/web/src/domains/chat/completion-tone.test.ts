import { describe, expect, it } from "bun:test";

import {
  guardianDecisionTone,
  inferCompletionTone,
} from "@/domains/chat/completion-tone";

describe("guardianDecisionTone", () => {
  it("marks a leave-unverified park as neutral, not a denial", () => {
    // A park holds the contact at `unverified` — neither trusted nor kept out —
    // so its completed card must not show the red rejection cross.
    expect(
      guardianDecisionTone("apr:req1:leave_unverified", { applied: true }),
    ).toBe("neutral");
  });

  it("marks block and reject as danger", () => {
    expect(guardianDecisionTone("apr:req1:block", { applied: true })).toBe(
      "danger",
    );
    expect(guardianDecisionTone("apr:req1:reject", { applied: true })).toBe(
      "danger",
    );
  });

  it("marks approve and trust as success", () => {
    expect(
      guardianDecisionTone("apr:req1:approve_once", { applied: true }),
    ).toBe("success");
    expect(guardianDecisionTone("apr:req1:trust", { applied: true })).toBe(
      "success",
    );
  });

  it("marks a decision that didn't apply as neutral regardless of action", () => {
    expect(guardianDecisionTone("apr:req1:block", { applied: false })).toBe(
      "neutral",
    );
    expect(
      guardianDecisionTone("apr:req1:approve_once", { applied: false }),
    ).toBe("neutral");
  });

  it("reads the action from a bare id without the apr: prefix", () => {
    expect(guardianDecisionTone("leave_unverified", { applied: true })).toBe(
      "neutral",
    );
  });
});

describe("inferCompletionTone", () => {
  it("reads the 'Left unverified' park label as neutral", () => {
    expect(inferCompletionTone("Left unverified")).toBe("neutral");
  });

  it("reads the guardian park reply as neutral", () => {
    expect(inferCompletionTone("Alice will stay unverified.")).toBe("neutral");
  });

  it("reads denial labels as danger", () => {
    expect(inferCompletionTone("Denied")).toBe("danger");
    expect(inferCompletionTone("Blocked")).toBe("danger");
  });

  it("reads voided terminal labels as neutral", () => {
    expect(inferCompletionTone("Expired")).toBe("neutral");
    expect(inferCompletionTone("Cancelled")).toBe("neutral");
  });

  it("keeps ordinary completed cards affirmative", () => {
    expect(inferCompletionTone("Approved")).toBe("success");
    expect(inferCompletionTone(undefined)).toBe("success");
  });
});
