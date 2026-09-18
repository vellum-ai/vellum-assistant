import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";

import { setOverridesForTesting } from "../__tests__/feature-flag-test-helpers.js";
import { asConversation } from "../__tests__/helpers/mock-conversation.js";
import {
  getBundledSkillsDir,
  type SkillToolManifest,
} from "../config/skills.js";
import { surfaceProxyResolver } from "../daemon/conversation-surfaces.js";
import { HostCuProxy } from "../daemon/host-cu-proxy.js";
import type { TrustContext } from "../daemon/trust-context-types.js";
import { supportsClientOsForSkillTool } from "../tools/client-os.js";
import { resolveExecutionTarget } from "../tools/execution-target.js";
import {
  createSkillTool,
  createSkillToolsFromManifest,
} from "../tools/skills/skill-tool-factory.js";
import { sensitiveToolReach } from "../tools/tool-approval-handler.js";
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

test("explicit computer use runs on the virtual desktop without a host client", async () => {
  const { ctx, proxy } = conversation();
  const execute = spyOn(
    computerUse,
    "executeDesktopComputerUse",
  ).mockResolvedValue({ content: "desktop", isError: false });
  spies.push(execute);
  expect(
    await surfaceProxyResolver(ctx, "computer_use_observe", {
      target: "assistant-desktop",
    }),
  ).toEqual({
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
    (
      await surfaceProxyResolver(ctx, "computer_use_observe", {
        target: "assistant-desktop",
      })
    ).isError,
  ).toBe(true);
  expect(execute).not.toHaveBeenCalled();
});

for (const input of [
  { target: "assistant-desktop", target_client_id: "client-123" },
  { target: "connected-computer", observation_id: "stale" },
  { target: "unknown" },
]) {
  test(`invalid target never dispatches: ${JSON.stringify(input)}`, async () => {
    const { ctx, proxy } = conversation();
    const execute = spyOn(computerUse, "executeDesktopComputerUse");
    const host = spyOn(proxy, "request");
    spies.push(execute, host);
    await expect(
      surfaceProxyResolver(ctx, "computer_use_observe", input),
    ).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
    expect(host).not.toHaveBeenCalled();
    expect(proxy.stepCount).toBe(0);
  });
}

for (const platform of [true, false]) {
  for (const clientOs of ["web", "macos", "windows", "linux"] as const) {
    test(`bundled tool policy and dispatch agree for ${platform ? "platform" : "local"} ${clientOs}`, async () => {
      process.env.IS_PLATFORM = String(platform);
      const skillDir = join(getBundledSkillsDir(), "computer-use");
      const manifest = JSON.parse(
        readFileSync(join(skillDir, "TOOLS.json"), "utf8"),
      ) as SkillToolManifest;
      const tools = createSkillToolsFromManifest(
        manifest.tools,
        skillDir,
        "",
        true,
      );
      const click = tools.find((tool) => tool.name === "computer_use_click")!;
      const { ctx, proxy } = conversation();
      ctx.currentTurnClientOs = clientOs;
      const local = spyOn(
        computerUse,
        "executeDesktopComputerUse",
      ).mockResolvedValue({ content: "desktop", isError: false });
      spies.push(local, spyOn(proxy, "isAvailable").mockReturnValue(false));
      const toolContext = {
        ...context,
        clientOs,
        workingDir: "/tmp",
        conversationId: "conv-123",
        proxyToolResolver: (name: string, args: Record<string, unknown>) =>
          surfaceProxyResolver(ctx, name, args),
      };
      for (const target of [
        undefined,
        "connected-computer",
        "assistant-desktop",
      ]) {
        const virtual =
          target === "assistant-desktop" ||
          (target === undefined && platform && clientOs === "web");
        const input = {
          target,
          x: 30,
          y: 40,
          reasoning: "Focus field",
          ...(virtual ? { observation_id: "observation-123" } : {}),
        };
        const boundary = resolveExecutionTarget(click, input, toolContext);
        expect(boundary).toBe(virtual ? "sandbox" : "host");
        if (virtual) {
          expect(sensitiveToolReach(click.name, boundary, input)).not.toBe(
            "host",
          );
        } else {
          expect(sensitiveToolReach(click.name, boundary, input)).toBe("host");
        }
        const calls = local.mock.calls.length;
        const result = await click.execute(input, toolContext);
        expect(result.isError).toBe(!(virtual && platform));
        expect(local).toHaveBeenCalledTimes(
          calls + (virtual && platform ? 1 : 0),
        );
      }
      const calls = local.mock.calls.length;
      const rejected = await click.execute(
        { target: "invalid", reasoning: "Focus field" },
        toolContext,
      );
      expect(rejected.isError).toBe(true);
      expect(local).toHaveBeenCalledTimes(calls);
      const entry = manifest.tools.find((tool) => tool.name === click.name)!;
      for (const tool of [
        createSkillTool(entry, "/tmp/skills/computer-use", "", true),
        createSkillTool(entry, skillDir, "", false),
        createSkillTool(entry, skillDir, "", true, "plugin-123"),
      ]) {
        expect(
          resolveExecutionTarget(
            tool,
            { target: "assistant-desktop" },
            toolContext,
          ),
        ).toBe("host");
      }
    });
  }
}

test("desktop revocation between policy and dispatch never falls back to the host", async () => {
  const { ctx, proxy } = conversation();
  const skillDir = join(getBundledSkillsDir(), "computer-use");
  const manifest = JSON.parse(
    readFileSync(join(skillDir, "TOOLS.json"), "utf8"),
  ) as SkillToolManifest;
  const observe = createSkillToolsFromManifest(
    manifest.tools,
    skillDir,
    "",
    true,
  ).find((tool) => tool.name === "computer_use_observe")!;
  const toolContext = {
    ...context,
    workingDir: "/tmp",
    conversationId: "conv-123",
  };
  expect(resolveExecutionTarget(observe, {}, toolContext)).toBe("sandbox");
  setOverridesForTesting({ "assistant-desktop": false });
  const local = spyOn(computerUse, "executeDesktopComputerUse");
  const host = spyOn(proxy, "request");
  spies.push(local, host, spyOn(proxy, "isAvailable").mockReturnValue(true));
  expect(
    (await surfaceProxyResolver(ctx, "computer_use_observe", {})).isError,
  ).toBe(true);
  expect(host).not.toHaveBeenCalled();
  expect(local).not.toHaveBeenCalled();
});

test("a disabled assistant desktop never falls back to a connected computer", async () => {
  setOverridesForTesting({ "assistant-desktop": false });
  const { ctx, proxy } = conversation();
  const local = spyOn(computerUse, "executeDesktopComputerUse");
  const host = spyOn(proxy, "request");
  spies.push(local, host, spyOn(proxy, "isAvailable").mockReturnValue(true));
  const result = await surfaceProxyResolver(ctx, "computer_use_observe", {
    target: "assistant-desktop",
  });
  expect(result.isError).toBe(true);
  expect(local).not.toHaveBeenCalled();
  expect(host).not.toHaveBeenCalled();
});
