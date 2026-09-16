import { describe, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";

import { useTenantHostInput } from "./use-tenant-host-input";

const SHOPIFY = {
  pattern: "^[a-z0-9][a-z0-9-]*\\.myshopify\\.com$",
  label: "Shop domain",
  placeholder: "your-store.myshopify.com",
};

describe("useTenantHostInput", () => {
  test("is inert for providers with one global host", () => {
    const { result } = renderHook(() => useTenantHostInput(null));
    expect(result.current.valid).toBe(true);
    expect(result.current.normalized).toBeUndefined();
    expect(result.current.showsInvalid).toBe(false);
  });

  test("blocks a connect until a host matching the pattern is typed", () => {
    const { result } = renderHook(() => useTenantHostInput(SHOPIFY));
    // Empty is not yet wrong, only not yet ready.
    expect(result.current.valid).toBe(false);
    expect(result.current.showsInvalid).toBe(false);

    act(() => result.current.setValue("evil.com"));
    expect(result.current.valid).toBe(false);
    expect(result.current.showsInvalid).toBe(true);

    // Normalized the way the platform normalizes, so what is validated here
    // is what gets sent.
    act(() => result.current.setValue("  My-Store.myshopify.com "));
    expect(result.current.valid).toBe(true);
    expect(result.current.showsInvalid).toBe(false);
    expect(result.current.normalized).toBe("my-store.myshopify.com");
  });
});
