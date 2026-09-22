import { beforeEach, describe, expect, test } from "bun:test";

import { setConfig } from "../__tests__/helpers/set-config.js";
import { getConfig } from "../config/loader.js";
import { requestSupportsInlineAudio } from "./inline-audio-support.js";

beforeEach(() => {
  setConfig("llm", { profiles: {} });
});

describe("requestSupportsInlineAudio", () => {
  test("catalog audio models stay true without a profile override", () => {
    expect(
      requestSupportsInlineAudio("thinkingmachines/inkling"),
    ).toBe(true);
  });

  test("unknown models fail closed unless a profile declares audio support", () => {
    expect(requestSupportsInlineAudio("qwen2.5-omni")).toBe(false);

    const config = getConfig() as { llm: { profiles: Record<string, unknown> } };
    config.llm = {
      profiles: {
        gateway: {
          provider: "openai-compatible",
          model: "qwen2.5-omni",
          inputModalities: { audio: { enabled: true, supported: true } },
        },
      },
    };

    expect(requestSupportsInlineAudio("qwen2.5-omni")).toBe(true);
  });
});
