import { afterEach, describe, expect, test } from "bun:test";

import {
  getSelfHostedIngressUrl,
  setSelfHostedIngressUrl,
} from "@/lib/self-hosted/ingress.js";

describe("self-hosted ingress slot", () => {
  afterEach(() => {
    setSelfHostedIngressUrl(null);
  });

  test("starts null", () => {
    expect(getSelfHostedIngressUrl()).toBeNull();
  });

  test("round-trips a value through the setter", () => {
    setSelfHostedIngressUrl("https://example.ngrok-free.app");
    expect(getSelfHostedIngressUrl()).toBe("https://example.ngrok-free.app");
  });

  test("setting null clears the slot", () => {
    setSelfHostedIngressUrl("https://example.ngrok-free.app");
    setSelfHostedIngressUrl(null);
    expect(getSelfHostedIngressUrl()).toBeNull();
  });
});
