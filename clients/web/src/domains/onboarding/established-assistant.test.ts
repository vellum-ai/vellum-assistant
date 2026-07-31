/**
 * Tests for the established-assistant guard's detection logic (dependency-
 * injected — no module mocks, so this file is safe in a shared `bun test` run).
 */

import { describe, expect, test } from "bun:test";

import {
  checkEstablishedAssistant,
  FRESH_ASSISTANT_CHECK,
} from "@/domains/onboarding/established-assistant";

type Deps = NonNullable<Parameters<typeof checkEstablishedAssistant>[1]>;

function makeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    hasAnyActiveConversation: async () => false,
    fetchAssistantIdentity: async () => null,
    ...overrides,
  } as Deps;
}

describe("checkEstablishedAssistant", () => {
  test("no conversations → fresh, without fetching identity", async () => {
    let identityFetched = false;
    const result = await checkEstablishedAssistant(
      "asst-1",
      makeDeps({
        fetchAssistantIdentity: async () => {
          identityFetched = true;
          return null;
        },
      }),
    );

    expect(result).toEqual(FRESH_ASSISTANT_CHECK);
    expect(identityFetched).toBe(false);
  });

  test("conversations present → established, with the trimmed identity name", async () => {
    const result = await checkEstablishedAssistant(
      "asst-1",
      makeDeps({
        hasAnyActiveConversation: async () => true,
        fetchAssistantIdentity: async () =>
          ({ name: "  Viper  " }) as Awaited<
            ReturnType<Deps["fetchAssistantIdentity"]>
          >,
      }),
    );

    expect(result).toEqual({ established: true, assistantName: "Viper" });
  });

  test("established with an unavailable or blank identity still gates", async () => {
    const nullIdentity = await checkEstablishedAssistant(
      "asst-1",
      makeDeps({ hasAnyActiveConversation: async () => true }),
    );
    expect(nullIdentity).toEqual({ established: true, assistantName: null });

    const blankName = await checkEstablishedAssistant(
      "asst-1",
      makeDeps({
        hasAnyActiveConversation: async () => true,
        fetchAssistantIdentity: async () =>
          ({ name: "   " }) as Awaited<
            ReturnType<Deps["fetchAssistantIdentity"]>
          >,
      }),
    );
    expect(blankName).toEqual({ established: true, assistantName: null });
  });

  test("a positive history signal gates even when the identity lookup throws", async () => {
    const result = await checkEstablishedAssistant(
      "asst-1",
      makeDeps({
        hasAnyActiveConversation: async () => true,
        fetchAssistantIdentity: async () => {
          throw new Error("identity route down");
        },
      }),
    );

    expect(result).toEqual({ established: true, assistantName: null });
  });

  test("fails open to fresh when the conversation probe throws", async () => {
    const result = await checkEstablishedAssistant(
      "asst-1",
      makeDeps({
        hasAnyActiveConversation: async () => {
          throw new Error("daemon unreachable");
        },
      }),
    );

    expect(result).toEqual(FRESH_ASSISTANT_CHECK);
  });
});
