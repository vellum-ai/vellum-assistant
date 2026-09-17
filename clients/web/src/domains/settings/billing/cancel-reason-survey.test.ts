import { describe, expect, test } from "bun:test";

import {
  CANCEL_REASON_OPTIONS,
  EMPTY_CANCEL_REASON,
  isCancelReasonComplete,
  toCancelRequestBody,
} from "./cancel-reason-survey";

describe("toCancelRequestBody", () => {
  test("a picked reason goes out with a null comment", () => {
    expect(
      toCancelRequestBody({ feedback: "too_expensive", comment: "" }),
    ).toEqual({ feedback: "too_expensive", comment: null });
  });

  test("Other carries the trimmed comment", () => {
    expect(
      toCancelRequestBody({ feedback: "other", comment: "  needs SSO  " }),
    ).toEqual({ feedback: "other", comment: "needs SSO" });
  });

  test("Other with a blank comment sends no comment", () => {
    expect(toCancelRequestBody({ feedback: "other", comment: "   " })).toEqual(
      { feedback: "other", comment: null },
    );
  });

  test("a comment typed under Other is dropped once another reason is picked", () => {
    expect(
      toCancelRequestBody({ feedback: "unused", comment: "left over" }),
    ).toEqual({ feedback: "unused", comment: null });
  });
});

describe("isCancelReasonComplete", () => {
  test("blank survey is incomplete; any reason completes it", () => {
    expect(isCancelReasonComplete(EMPTY_CANCEL_REASON)).toBe(false);
    for (const feedback of CANCEL_REASON_OPTIONS) {
      expect(isCancelReasonComplete({ feedback, comment: "" })).toBe(true);
    }
  });
});
