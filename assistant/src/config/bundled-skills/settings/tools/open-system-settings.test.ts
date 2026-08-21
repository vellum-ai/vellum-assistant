import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ToolContext } from "../../../../tools/types.js";

let windowsHost = true;

mock.module("../../../../util/platform.js", () => ({
  isWindows: () => windowsHost,
}));

const { run } = await import("./open-system-settings.js");

let sentMessages: Array<{ type: string; [key: string]: unknown }> = [];

function makeContext(): ToolContext {
  return {
    workingDir: "/tmp",
    conversationId: "conv-xyz",
    trustClass: "guardian",
    sendToClient: (message) => {
      sentMessages.push(message);
    },
  };
}

describe("open_system_settings tool", () => {
  beforeEach(() => {
    sentMessages = [];
    windowsHost = true;
  });

  test("opens Windows microphone privacy settings", async () => {
    const result = await run(
      { pane: "microphone", platform: "windows" },
      makeContext(),
    );

    expect(result).toEqual({
      content:
        "Opened Windows Settings to Microphone privacy. Please enable Vellum Assistant.",
      isError: false,
    });
    expect(sentMessages).toEqual([
      {
        type: "open_url",
        url: "ms-settings:privacy-microphone",
        conversationId: "conv-xyz",
      },
    ]);
  });

  test("opens macOS speech recognition settings", async () => {
    const result = await run(
      { pane: "speech_recognition", platform: "macos" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(sentMessages).toEqual([
      {
        type: "open_url",
        url: "x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition",
        conversationId: "conv-xyz",
      },
    ]);
  });

  test("uses the host platform when the client platform is absent", async () => {
    const result = await run({ pane: "microphone" }, makeContext());

    expect(result.isError).toBe(false);
    expect(sentMessages[0]?.url).toBe("ms-settings:privacy-microphone");
  });

  test("rejects an unsupported platform", async () => {
    const result = await run(
      { pane: "microphone", platform: "linux" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('unknown platform "linux"');
    expect(sentMessages).toEqual([]);
  });
});
