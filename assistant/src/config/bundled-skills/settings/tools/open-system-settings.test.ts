import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ToolContext } from "../../../../tools/types.js";

let windowsHost = true;
let linuxHost = false;

mock.module("../../../../util/platform.js", () => ({
  isWindows: () => windowsHost,
  isLinux: () => linuxHost,
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
    linuxHost = false;
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
      { pane: "microphone", platform: "haiku-os" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('unknown platform "haiku-os"');
    expect(sentMessages).toEqual([]);
  });

  test("offers a desktop command on Linux without pushing open_url", async () => {
    const result = await run(
      { pane: "microphone", platform: "linux" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("gnome-control-center privacy");
    expect(result.content).toContain("systemsettings kcm_kscreen");
    expect(result.content).not.toContain("x-apple.systempreferences");
    expect(result.content).not.toContain("ms-settings:");
    expect(sentMessages).toEqual([]);
  });

  test("defaults to Linux when the host is Linux", async () => {
    windowsHost = false;
    linuxHost = true;

    const result = await run({ pane: "speech_recognition" }, makeContext());

    expect(result.isError).toBe(false);
    expect(result.content).toContain("gnome-control-center privacy");
    expect(sentMessages).toEqual([]);
  });
});
