/**
 * Which name catalog copy interpolates, and when it falls back.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

import {
  readActivationAssistantName,
  resolveActivationAssistantName,
} from "./activation-assistant-name";
import { seedActivationIdentity } from "./activation-test-helpers";

const FALLBACK = "your assistant";

afterEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
  useResolvedAssistantsStore.setState({
    activeAssistantId: null,
    assistants: [],
  });
});

describe("resolveActivationAssistantName", () => {
  test("uses a trimmed name", () => {
    expect(resolveActivationAssistantName("  Luna  ", FALLBACK)).toBe("Luna");
  });

  test("falls back when the name is missing or blank", () => {
    expect(resolveActivationAssistantName(null, FALLBACK)).toBe(FALLBACK);
    expect(resolveActivationAssistantName(undefined, FALLBACK)).toBe(FALLBACK);
    expect(resolveActivationAssistantName("   ", FALLBACK)).toBe(FALLBACK);
  });
});

describe("readActivationAssistantName", () => {
  test("prefers the identity name for the matching assistant", () => {
    seedActivationIdentity("asst-1");
    expect(readActivationAssistantName("asst-1")).toBe("Vel");
  });

  test("uses the resolved assistant name when identity belongs elsewhere", () => {
    seedActivationIdentity("asst-other");
    useResolvedAssistantsStore.setState({
      assistants: [
        {
          id: "asst-1",
          name: "Luna",
          isLocal: true,
          isPlatformHosted: false,
          isPaired: false,
        },
      ],
    });
    expect(readActivationAssistantName("asst-1")).toBe("Luna");
  });

  test("returns null when nothing has a name", () => {
    expect(readActivationAssistantName(null)).toBeNull();
    expect(readActivationAssistantName("asst-1")).toBeNull();
  });
});
