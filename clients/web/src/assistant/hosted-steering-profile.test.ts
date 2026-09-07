import { describe, expect, test } from "bun:test";

import {
  HOSTED_STEERING_MODEL,
  HOSTED_STEERING_PROVIDER,
  isHostedSteeringProfile,
} from "./hosted-steering-profile";

describe("isHostedSteeringProfile", () => {
  test("matches only vellum + qwen/qwen3-8b", () => {
    expect(
      isHostedSteeringProfile(HOSTED_STEERING_PROVIDER, HOSTED_STEERING_MODEL),
    ).toBe(true);
    expect(isHostedSteeringProfile("vellum", "qwen/qwen3-32b")).toBe(false);
    expect(isHostedSteeringProfile("anthropic", HOSTED_STEERING_MODEL)).toBe(
      false,
    );
    expect(isHostedSteeringProfile(undefined, HOSTED_STEERING_MODEL)).toBe(
      false,
    );
    expect(isHostedSteeringProfile(HOSTED_STEERING_PROVIDER, undefined)).toBe(
      false,
    );
  });
});
