import { describe, expect, test } from "bun:test";

import { createAdapterFromConnection } from "../inference/adapter-factory.js";
import type { ProviderConnection } from "../inference/auth.js";
import type { ResolvedAuth } from "../inference/auth.js";
import { isVellumManagedConnection } from "../vellum-model-routing.js";

const vellumConnection = {
  name: "vellum",
  provider: "vellum",
  auth: { type: "platform" },
  label: "Vellum",
} as unknown as ProviderConnection;

const resolvedAuth: ResolvedAuth = {
  kind: "header",
  headers: { Authorization: "Bearer test-key" },
  baseUrl: "https://platform.example/v1/runtime-proxy/fireworks",
};

describe("vellum connection routing", () => {
  test("isVellumManagedConnection identifies the sentinel connection", () => {
    expect(isVellumManagedConnection(vellumConnection)).toBe(true);
    expect(
      isVellumManagedConnection({
        provider: "fireworks",
        auth: { type: "platform" },
      }),
    ).toBe(false);
    // `vellum` provider with non-platform auth is not a managed vellum route.
    expect(
      isVellumManagedConnection({ provider: "vellum", auth: { type: "none" } }),
    ).toBe(false);
  });

  test("the vellum sentinel is not a real provider without an override", () => {
    // No `provider` override → effective provider is the `vellum` sentinel,
    // which has no catalog entry / adapter → null.
    const adapter = createAdapterFromConnection(
      vellumConnection,
      resolvedAuth,
      {
        model: "accounts/fireworks/models/kimi-k2p5",
      },
    );
    expect(adapter).toBeNull();
  });

  test("provider override routes the vellum connection to the real upstream", () => {
    const adapter = createAdapterFromConnection(
      vellumConnection,
      resolvedAuth,
      {
        model: "accounts/fireworks/models/kimi-k2p5",
        provider: "fireworks",
      },
    );
    expect(adapter).not.toBeNull();
  });
});
