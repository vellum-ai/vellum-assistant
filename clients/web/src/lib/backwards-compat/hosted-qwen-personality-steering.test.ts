import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  assistantSupportsHostedQwenPersonalitySteering,
  MIN_VERSION,
} from "@/lib/backwards-compat/hosted-qwen-personality-steering";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

function setVersion(version: string | null) {
  useAssistantIdentityStore.getState().setIdentity("test-asst", version);
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("assistantSupportsHostedQwenPersonalitySteering", () => {
  test("returns false when the version stays unknown past the wait", async () => {
    setVersion(null);
    expect(
      await assistantSupportsHostedQwenPersonalitySteering(null, 1),
    ).toBe(false);
  });

  test("waits for hydration before deciding", async () => {
    setVersion(null);
    const decision = assistantSupportsHostedQwenPersonalitySteering(null, 1_000);
    setVersion("0.11.10");
    expect(await decision).toBe(true);
  });

  test("returns false for the 0.11.9 stable release and older", async () => {
    setVersion("0.11.9");
    expect(await assistantSupportsHostedQwenPersonalitySteering()).toBe(false);
    setVersion("0.11.8");
    expect(await assistantSupportsHostedQwenPersonalitySteering()).toBe(false);
  });

  test("returns false for dev builds cut before the feature commit", async () => {
    setVersion("0.11.9-dev.202609071543.aaaaaaa");
    expect(await assistantSupportsHostedQwenPersonalitySteering()).toBe(false);
  });

  test("returns true from the feature commit's dev build onward", async () => {
    setVersion(MIN_VERSION);
    expect(await assistantSupportsHostedQwenPersonalitySteering()).toBe(true);
    setVersion("0.11.9-dev.202609071600.bbbbbbb");
    expect(await assistantSupportsHostedQwenPersonalitySteering()).toBe(true);
  });

  test("returns true for every later release, whatever it is numbered", async () => {
    setVersion("0.11.10");
    expect(await assistantSupportsHostedQwenPersonalitySteering()).toBe(true);
    setVersion("0.12.0");
    expect(await assistantSupportsHostedQwenPersonalitySteering()).toBe(true);
  });

  test("a hydrated identity for a different assistant gates to legacy", async () => {
    useAssistantIdentityStore
      .getState()
      .setIdentity("other-asst", "0.11.10", "asst-B");
    expect(
      await assistantSupportsHostedQwenPersonalitySteering("asst-A"),
    ).toBe(false);
    expect(
      await assistantSupportsHostedQwenPersonalitySteering("asst-B"),
    ).toBe(true);
    expect(await assistantSupportsHostedQwenPersonalitySteering(null)).toBe(
      true,
    );
  });
});
