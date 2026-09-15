import { expect, test } from "bun:test";
import { ApiError } from "@/utils/api-errors";
import { mcpSetupErrorKey } from "./mcp-setup-error";

test("recognizes both gateway and assistant error envelopes", () => {
  for (const error of [
    { code: "PUBLIC_INGRESS_DISABLED", error: "Details" },
    { error: { code: "PUBLIC_INGRESS_DISABLED", message: "Details" } },
    new ApiError(422, "Details", { code: "PUBLIC_INGRESS_DISABLED" }),
  ]) {
    expect(mcpSetupErrorKey(error)).toBe("mcpConnect.callbackDisabled");
  }
});
test("unknown and legacy errors retain generic copy", () => {
  for (const error of [
    null,
    "error",
    new Error("Private detail"),
    { error: { code: "NEW_CODE" } },
  ]) {
    expect(mcpSetupErrorKey(error)).toBeUndefined();
  }
});
