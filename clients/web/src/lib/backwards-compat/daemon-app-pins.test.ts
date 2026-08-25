import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import type * as UseAssistantCapability from "@/hooks/use-assistant-capability";

let advertised: string[] = [];

mock.module(
  "@/hooks/use-assistant-capability",
  (): Partial<typeof UseAssistantCapability> => ({
    useAssistantCapability: (capability: string) =>
      advertised.includes(capability),
  }),
);

const { useSupportsDaemonAppPins } =
  await import("@/lib/backwards-compat/daemon-app-pins");

function supportsWith(capabilities: string[]): boolean {
  advertised = capabilities;
  return renderHook(() => useSupportsDaemonAppPins()).result.current;
}

afterEach(cleanup);

describe("useSupportsDaemonAppPins", () => {
  test("is true when the daemon advertises appPins", () => {
    expect(supportsWith(["appPins"])).toBe(true);
  });

  /* The conservative answer, and the one every first render sees: the healthz
     read is a query, so the flag is false until it resolves. Reading `true`
     here would send a pin to a daemon with no route for it. */
  test("is false when nothing is advertised", () => {
    expect(supportsWith([])).toBe(false);
  });

  /* Guards the capability name, which is a string on both sides of the wire:
     a daemon advertising its other flags but not this one must not light the
     pin route up. */
  test("is false for a daemon advertising only other capabilities", () => {
    expect(supportsWith(["memoryOptOut", "retryLastTurn"])).toBe(false);
  });
});
