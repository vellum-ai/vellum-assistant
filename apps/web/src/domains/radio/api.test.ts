import { describe, expect, it } from "bun:test";

import { runtimeAudioUrl } from "@/domains/radio/api.js";

describe("runtimeAudioUrl", () => {
  it("encodes assistant ids and path segments", () => {
    expect(runtimeAudioUrl("assistant 1", "audio/dj break")).toBe(
      "/v1/assistants/assistant%201/audio/dj%20break/",
    );
  });

  it("normalizes duplicate slashes in runtime audio paths", () => {
    expect(
      runtimeAudioUrl("assistant-1", "/radio//tracks///soft-launch/"),
    ).toBe("/v1/assistants/assistant-1/radio/tracks/soft-launch/");
  });

  it("rejects empty runtime audio paths", () => {
    expect(() => runtimeAudioUrl("assistant-1", "")).toThrow(
      "Radio audio path is required.",
    );
    expect(() => runtimeAudioUrl("assistant-1", "///")).toThrow(
      "Radio audio path is required.",
    );
  });

  it("rejects traversal segments before encoding", () => {
    expect(() => runtimeAudioUrl("assistant-1", "audio/../secret")).toThrow(
      "Radio audio path cannot include traversal segments.",
    );
    expect(() =>
      runtimeAudioUrl("assistant-1", "radio/tracks/./soft-launch"),
    ).toThrow("Radio audio path cannot include traversal segments.");
  });

  it("rejects unsupported runtime audio prefixes", () => {
    expect(() => runtimeAudioUrl("assistant-1", "files/secret")).toThrow(
      "Unsupported radio audio path.",
    );
    expect(() => runtimeAudioUrl("assistant-1", "radio/other/id")).toThrow(
      "Unsupported radio audio path.",
    );
    expect(() => runtimeAudioUrl("assistant-1", "radio/tracks")).toThrow(
      "Unsupported radio audio path.",
    );
  });
});
