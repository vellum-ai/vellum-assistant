import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";

import { setOverridesForTesting } from "../__tests__/feature-flag-test-helpers.js";
import { asConversation } from "../__tests__/helpers/mock-conversation.js";
import { surfaceProxyResolver } from "../daemon/conversation-surfaces.js";
import { HostCuProxy } from "../daemon/host-cu-proxy.js";
import type { TrustContext } from "../daemon/trust-context-types.js";
import { supportsClientOsForSkillTool } from "../tools/client-os.js";
import * as computerUse from "./desktop-computer-use.js";
import { shouldUseVirtualDesktop } from "./virtual-desktop-feature.js";

const originalPlatform = process.env.IS_PLATFORM;
const originalContainerized = process.env.IS_CONTAINERIZED;
const context = {
  trustClass: "guardian" as const,
  sourceActorPrincipalId: "user-123",
  transportInterface: "web" as const,
  clientOs: "web" as const,
};
const spies: Array<{ mockRestore(): void }> = [];

beforeEach(() => {
  process.env.IS_PLATFORM = "true";
  process.env.IS_CONTAINERIZED = "true";
  setOverridesForTesting({ "assistant-desktop": true });
});

afterEach(() => {
  for (const spy of spies.splice(0)) {
    spy.mockRestore();
  }
  setOverridesForTesting({});
  if (originalPlatform === undefined) {
    delete process.env.IS_PLATFORM;
  } else {
    process.env.IS_PLATFORM = originalPlatform;
  }
  if (originalContainerized === undefined) {
    delete process.env.IS_CONTAINERIZED;
  } else {
    process.env.IS_CONTAINERIZED = originalContainerized;
  }
});

function conversation() {
  const proxy = new HostCuProxy(10);
  const ctx = asConversation({
    workingDir: "/tmp",
    conversationId: "conv-123",
    transportInterface: "web",
    currentTurnClientOs: "web",
    currentTurnSourceActorPrincipalId: "user-123",
    getTurnOrRestingTrust: (): TrustContext => ({
      sourceChannel: "vellum",
      trustClass: "guardian",
    }),
    hostCuProxy: proxy,
  });
  return { ctx, proxy };
}

test("web computer use runs on the virtual desktop without a host client", async () => {
  const { ctx, proxy } = conversation();
  const execute = spyOn(
    computerUse,
    "executeDesktopComputerUse",
  ).mockResolvedValue({ content: "desktop", isError: false });
  spies.push(execute);
  expect(await surfaceProxyResolver(ctx, "computer_use_observe", {})).toEqual({
    content: "desktop",
    isError: false,
  });
  expect(execute.mock.calls[0][2]).toMatchObject({
    conversationId: "conv-123",
    ...context,
  });
  expect(execute.mock.calls[0][3]).toBe(proxy);
});

test("explicit host targets never fall through to the virtual desktop", async () => {
  const { ctx, proxy } = conversation();
  const execute = spyOn(
    computerUse,
    "executeDesktopComputerUse",
  ).mockResolvedValue({ content: "desktop", isError: false });
  spies.push(execute, spyOn(proxy, "isAvailable").mockReturnValue(false));
  expect(
    (
      await surfaceProxyResolver(ctx, "computer_use_click", {
        target_client_id: "missing-client",
        x: 1,
        y: 2,
      })
    ).isError,
  ).toBe(true);
  expect(execute).not.toHaveBeenCalled();
});

test("screen annotations stay on the host path", async () => {
  const { ctx, proxy } = conversation();
  const execute = spyOn(
    computerUse,
    "executeDesktopComputerUse",
  ).mockResolvedValue({ content: "desktop", isError: false });
  spies.push(execute, spyOn(proxy, "isAvailable").mockReturnValue(false));
  expect(
    (await surfaceProxyResolver(ctx, "computer_use_point_at", {})).isError,
  ).toBe(true);
  expect(execute).not.toHaveBeenCalled();
});

test("native, unidentified and non-guardian turns do not select the virtual desktop", () => {
  for (const clientOs of ["macos", "windows", "linux"] as const) {
    expect(shouldUseVirtualDesktop({ ...context, clientOs })).toBe(false);
  }
  expect(
    shouldUseVirtualDesktop({ ...context, sourceActorPrincipalId: undefined }),
  ).toBe(false);
  expect(shouldUseVirtualDesktop({ ...context, trustClass: "unknown" })).toBe(
    false,
  );
  process.env.IS_PLATFORM = "false";
  expect(shouldUseVirtualDesktop(context)).toBe(false);
});

test("web skill tools include supported desktop actions without a native client", () => {
  expect(
    supportsClientOsForSkillTool(["macos"], "computer_use_sequence", context),
  ).toBe(true);
  expect(
    supportsClientOsForSkillTool(
      ["macos", "windows"],
      "computer_use_drag",
      context,
    ),
  ).toBe(true);
  expect(
    supportsClientOsForSkillTool(
      ["macos"],
      "computer_use_run_applescript",
      context,
    ),
  ).toBe(false);
});

test("routing uses frozen turn trust even when the resting conversation is guardian", async () => {
  const { ctx, proxy } = conversation();
  ctx.trustContext = { sourceChannel: "vellum", trustClass: "guardian" };
  ctx.getTurnOrRestingTrust = () => ({
    sourceChannel: "vellum",
    trustClass: "unknown",
  });
  const execute = spyOn(
    computerUse,
    "executeDesktopComputerUse",
  ).mockResolvedValue({ content: "desktop", isError: false });
  spies.push(execute, spyOn(proxy, "isAvailable").mockReturnValue(false));
  expect(
    (await surfaceProxyResolver(ctx, "computer_use_observe", {})).isError,
  ).toBe(true);
  expect(execute).not.toHaveBeenCalled();
});
