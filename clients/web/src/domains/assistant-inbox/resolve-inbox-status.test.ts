import { describe, expect, test } from "bun:test";

import {
  resolveInboxStatus,
  type InboxStatusInputs,
} from "./resolve-inbox-status";

const BASE: InboxStatusInputs = {
  gate: "full",
  platformAssistantId: "asst-platform",
  entitlements: { managed_email: true },
  subscriptionFailed: false,
  addressCount: 1,
  domainsSettled: true,
};

describe("resolveInboxStatus", () => {
  test("loads while the platform gate is still pending", () => {
    expect(resolveInboxStatus({ ...BASE, gate: "pending" })).toBe("loading");
  });

  test("is unavailable off the platform, whatever else is known", () => {
    expect(resolveInboxStatus({ ...BASE, gate: "gated" })).toBe("unavailable");
    expect(resolveInboxStatus({ ...BASE, gate: "disabled" })).toBe(
      "unavailable",
    );
  });

  test("loads until the subscription answers", () => {
    expect(resolveInboxStatus({ ...BASE, entitlements: undefined })).toBe(
      "loading",
    );
  });

  test("upgrade when the entitlements explicitly omit managed email", () => {
    expect(resolveInboxStatus({ ...BASE, entitlements: {} })).toBe("upgrade");
    expect(
      resolveInboxStatus({ ...BASE, entitlements: { managed_email: false } }),
    ).toBe("upgrade");
  });

  test("a failed subscription read fails open to the address list", () => {
    expect(
      resolveInboxStatus({
        ...BASE,
        entitlements: undefined,
        subscriptionFailed: true,
      }),
    ).toBe("ready");
  });

  test("loads until the platform id and the address list are in", () => {
    expect(resolveInboxStatus({ ...BASE, platformAssistantId: null })).toBe(
      "loading",
    );
    expect(resolveInboxStatus({ ...BASE, addressCount: undefined })).toBe(
      "loading",
    );
  });

  test("ready with an address, whatever the domain list says", () => {
    expect(resolveInboxStatus(BASE)).toBe("ready");
    expect(resolveInboxStatus({ ...BASE, domainsSettled: false })).toBe(
      "ready",
    );
  });

  test("setup only once the domain list has settled", () => {
    expect(
      resolveInboxStatus({ ...BASE, addressCount: 0, domainsSettled: false }),
    ).toBe("loading");
    expect(resolveInboxStatus({ ...BASE, addressCount: 0 })).toBe("setup");
  });
});
