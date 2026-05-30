import { describe, expect, it } from "bun:test";

import {
  fetchRadioAudioObjectUrl,
  runtimeAudioUrl,
} from "@/domains/radio/api.js";

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

describe("fetchRadioAudioObjectUrl", () => {
  it("loads audio through the API client and returns a revokable blob URL", async () => {
    const blob = new Blob(["wav-bytes"], { type: "audio/wav" });
    const calls: unknown[] = [];
    const revokedUrls: string[] = [];

    const result = await fetchRadioAudioObjectUrl(
      "/v1/assistants/assistant-1/radio/tracks/soft-launch/",
      {
        get: async (options) => {
          calls.push(options);
          return {
            data: blob,
            response: new Response(blob, {
              headers: { "Content-Type": "audio/wav" },
            }),
          };
        },
        createObjectURL: (audioBlob) => {
          expect(audioBlob).toBe(blob);
          return "blob:radio-audio";
        },
        revokeObjectURL: (url) => {
          revokedUrls.push(url);
        },
      },
    );

    expect(calls).toEqual([
      expect.objectContaining({
        url: "/v1/assistants/assistant-1/radio/tracks/soft-launch/",
        parseAs: "blob",
        throwOnError: false,
      }),
    ]);
    expect(result.url).toBe("blob:radio-audio");

    result.revoke();
    expect(revokedUrls).toEqual(["blob:radio-audio"]);
  });
});
