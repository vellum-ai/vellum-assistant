import { expect, test } from "bun:test";

import { mcpCancellationAttemptId } from "./mcp-auth-cancellation";

test("legacy assistants can only stop client-side waiting", () => {
  expect(mcpCancellationAttemptId({})).toBeUndefined();
  expect(mcpCancellationAttemptId({ attempt_id: "" })).toBeUndefined();
  expect(mcpCancellationAttemptId({ attempt_id: false })).toBeUndefined();
});

test("an attempt-scoped capability works without predicting a release version", () => {
  expect(mcpCancellationAttemptId({ attempt_id: "attempt-123" })).toBe(
    "attempt-123",
  );
});
