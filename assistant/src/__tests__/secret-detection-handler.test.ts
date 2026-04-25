import { beforeEach, describe, expect, mock, test } from "bun:test";

const scanTextMock = mock(() => [
  { type: "api_key", redactedValue: "sk-***redacted***" },
]);

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    secretDetection: {
      enabled: true,
      action: "prompt",
      entropyThreshold: 4.5,
      customPatterns: [],
    },
  }),
}));

mock.module("../security/secret-scanner.js", () => ({
  compileCustomPatterns: () => [],
  redactSecrets: (content: string) => content,
  scanText: scanTextMock,
}));

import { SecretDetectionHandler } from "../tools/secret-detection-handler.js";

describe("SecretDetectionHandler", () => {
  beforeEach(() => {
    scanTextMock.mockClear();
  });

  test("blocks secret output without opening a deterministic approval prompt", async () => {
    const promptMock = mock(async () => ({ decision: "allow" as const }));
    const handler = new SecretDetectionHandler({
      prompt: promptMock,
    } as never);
    const emitLifecycleEvent = mock(() => {});

    const result = await handler.handle(
      { content: "secret output", isError: false },
      "bash",
      { command: "print-secret" },
      {
        conversationId: "conv-1",
        workingDir: "/tmp",
        requestId: "req-1",
        isInteractive: true,
      } as never,
      "sandbox",
      "medium",
      "allow",
      Date.now(),
      emitLifecycleEvent,
    );

    expect(result.earlyReturn).toBe(true);
    expect(result.result.isError).toBe(true);
    expect(result.result.content).toContain("Ask the user for confirmation conversationally");
    expect(promptMock).not.toHaveBeenCalled();
    expect(emitLifecycleEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "permission_denied",
        decision: "deny",
      }),
    );
  });
});
