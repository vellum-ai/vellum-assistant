import { describe, expect, test } from "bun:test";

import { AcpSessionModelUpdateEventSchema } from "./acp-session-model-update.js";

describe("AcpSessionModelUpdateEventSchema", () => {
  test("parses an event carrying the selection and grouped options", () => {
    const event = {
      type: "acp_session_model_update" as const,
      acpSessionId: "acp-session-abc",
      modelRevision: 7,
      model: "opus",
      availableModels: [
        { value: "opus", label: "Opus", description: "Most capable" },
        { value: "sonnet", label: "Sonnet", group: "Recommended" },
      ],
    };

    const result = AcpSessionModelUpdateEventSchema.safeParse(event);

    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual(event);
  });

  test("parses an adapter with no selection and no options", () => {
    const event = {
      type: "acp_session_model_update" as const,
      acpSessionId: "acp-session-abc",
      modelRevision: 8,
      availableModels: [],
    };

    const result = AcpSessionModelUpdateEventSchema.safeParse(event);

    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual(event);
  });

  test("rejects a missing availableModels array", () => {
    const result = AcpSessionModelUpdateEventSchema.safeParse({
      type: "acp_session_model_update",
      acpSessionId: "acp-session-abc",
      modelRevision: 9,
      model: "opus",
    });

    expect(result.success).toBe(false);
  });

  test("rejects a missing model revision", () => {
    const result = AcpSessionModelUpdateEventSchema.safeParse({
      type: "acp_session_model_update",
      acpSessionId: "acp-session-abc",
      availableModels: [],
    });

    expect(result.success).toBe(false);
  });

  test("rejects an unrecognized field under .strict()", () => {
    const result = AcpSessionModelUpdateEventSchema.safeParse({
      type: "acp_session_model_update",
      acpSessionId: "acp-session-abc",
      modelRevision: 10,
      availableModels: [],
      unexpected: true,
    });

    expect(result.success).toBe(false);
  });
});
