import { describe, expect, test } from "bun:test";
import { renderHook } from "@testing-library/react";

import { useTenantHostRequirement } from "./use-tenant-host-requirement";

const WIRE = {
  pattern: "^[a-z0-9][a-z0-9-]*\\.myshopify\\.com$",
  label: "Shop domain (daemon)",
  placeholder: "daemon-placeholder.myshopify.com",
};

describe("useTenantHostRequirement", () => {
  test("null on the wire means a provider with one global host", () => {
    const { result } = renderHook(() =>
      useTenantHostRequirement("github", null),
    );
    expect(result.current).toBeNull();
  });

  test("takes the pattern from the wire and the copy from the catalog", () => {
    const { result } = renderHook(() =>
      useTenantHostRequirement("shopify", WIRE),
    );
    expect(result.current).toEqual({
      pattern: WIRE.pattern,
      label: "Shop domain",
      placeholder: "your-store.myshopify.com",
    });
  });

  test("falls back to the daemon's copy for a provider the catalog lacks", () => {
    const { result } = renderHook(() =>
      useTenantHostRequirement("acme", { ...WIRE, label: "Tenant" }),
    );
    expect(result.current?.label).toBe("Tenant");
  });

  test("an absent wire field is an older assistant, which still gets Shopify", () => {
    // A current assistant always sends the key, so `undefined` cannot mean
    // "global host"; it means the summary predates the field.
    const shopify = renderHook(() =>
      useTenantHostRequirement("shopify", undefined),
    );
    expect(shopify.result.current?.pattern).toBe(WIRE.pattern);
    expect(shopify.result.current?.label).toBe("Shop domain");

    const github = renderHook(() =>
      useTenantHostRequirement("github", undefined),
    );
    expect(github.result.current).toBeNull();
  });
});
