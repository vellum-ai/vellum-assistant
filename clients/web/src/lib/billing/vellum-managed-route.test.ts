/**
 * Tests for `profileUsesVellumCredits` — the predicate that tells a
 * platform-billed profile from a bring-your-own one, across both wire shapes
 * the daemon has written (routing identity, and the legacy managed-upstream
 * + `vellum` binding).
 */
import { describe, expect, test } from "bun:test";

import { profileUsesVellumCredits } from "./vellum-managed-route";

const CONNECTIONS = [
  { name: "vellum", provider: "vellum" },
  { name: "openai-personal", provider: "openai" },
  { name: "chatgpt-subscription", provider: "openai" },
];

describe("profileUsesVellumCredits", () => {
  test("the vellum routing identity is billed to credits", () => {
    expect(
      profileUsesVellumCredits(
        { provider: "vellum", model: "gpt-5.6-luna" },
        CONNECTIONS,
      ),
    ).toBe(true);
  });

  test("a managed upstream bound to the vellum connection is billed to credits", () => {
    expect(
      profileUsesVellumCredits(
        {
          provider: "fireworks",
          model: "accounts/fireworks/models/glm-5p2",
          provider_connection: "vellum",
        },
        CONNECTIONS,
      ),
    ).toBe(true);
  });

  test("a BYOK key connection is not billed to credits", () => {
    expect(
      profileUsesVellumCredits(
        {
          provider: "openai",
          model: "gpt-5.5",
          provider_connection: "openai-personal",
        },
        CONNECTIONS,
      ),
    ).toBe(false);
  });

  test("a ChatGPT subscription connection is not billed to credits", () => {
    expect(
      profileUsesVellumCredits(
        {
          provider: "openai",
          model: "gpt-5.3-codex",
          provider_connection: "chatgpt-subscription",
        },
        CONNECTIONS,
      ),
    ).toBe(false);
  });

  test("the chatgpt routing identity is not billed to credits", () => {
    // The identity names no binding of its own; dispatch sends it to the
    // subscription connection, never the managed route.
    expect(
      profileUsesVellumCredits(
        { provider: "chatgpt", model: "gpt-5.3-codex" },
        CONNECTIONS,
      ),
    ).toBe(false);
  });

  test("a profile naming no connection is unknown", () => {
    expect(
      profileUsesVellumCredits(
        { provider: "openai", model: "gpt-5.5" },
        CONNECTIONS,
      ),
    ).toBe(null);
  });

  test("a binding with no matching row is unknown", () => {
    expect(
      profileUsesVellumCredits(
        {
          provider: "openai",
          model: "gpt-5.5",
          provider_connection: "deleted-connection",
        },
        CONNECTIONS,
      ),
    ).toBe(null);
  });

  test("a mix profile is unknown — its arm is picked inside the daemon", () => {
    expect(
      profileUsesVellumCredits(
        { mix: [{ profile: "chatgpt-sub", weight: 1 }] },
        CONNECTIONS,
      ),
    ).toBe(null);
  });
});
