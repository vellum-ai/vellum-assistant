import { join } from "node:path";
import { afterEach, expect, mock, spyOn, test } from "bun:test";

import { getBundledSkillsDir } from "../config/skills.js";
import * as permissionChecker from "../permissions/checker.js";
import { RiskLevel } from "../permissions/types.js";
import { parseToolManifestFile } from "../skills/tool-manifest.js";
import { computeSkillVersionHash } from "../skills/version-hash.js";
import { resolveExecutionTarget } from "../tools/execution-target.js";
import { buildPolicyContext } from "../tools/policy-context.js";
import { registerSkillTools, unregisterSkillTools } from "../tools/registry.js";
import {
  createSkillTool,
  createSkillToolsFromManifest,
} from "../tools/skills/skill-tool-factory.js";
import type { ToolContext } from "../tools/types.js";
import { DesktopAutomationLease } from "./desktop-automation-lease.js";
import { DesktopControl, desktopControl } from "./desktop-control.js";
import type { DesktopInput } from "./desktop-input.js";
import type { DesktopSessionManager } from "./desktop-session-manager.js";

const context: ToolContext = {
  conversationId: "conversation-123",
  sourceActorPrincipalId: "user-123",
  trustClass: "guardian",
  workingDir: process.env.VELLUM_WORKSPACE_DIR!,
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});
function fixture() {
  let enabled = true;
  let ready = true;
  const input = {
    observe: mock(async () => ({
      png: Buffer.from("screenshot"),
      width: 1440,
      height: 900,
    })),
    perform: mock<DesktopInput["perform"]>(async () => {}),
    releaseInput: mock(async () => {}),
  };
  const started = mock(async () => {});
  const releaseBrowser = mock(async () => {});
  const released = mock(() => {});
  const lease = new DesktopAutomationLease({
    enabled: () => enabled,
    ready: () => ready,
    ensureReady: async () => {
      throw new Error("Desktop setup required");
    },
    manager: () =>
      ({
        browser: { release: releaseBrowser },
        acquireAutomationSlot: () => ({ ok: true }),
        releaseAutomationSlot: released,
        ensureDesktopRunning: started,
      }) as unknown as DesktopSessionManager,
  });
  const control = new DesktopControl(lease, input, releaseBrowser);
  const execute = spyOn(desktopControl, "execute").mockImplementation(
    (args, ctx) => control.execute(args, ctx),
  );
  cleanups.push(async () => {
    await control.execute({ action: "done" }, context);
    execute.mockRestore();
  });
  const dir = join(getBundledSkillsDir(), "computer-use");
  const tools = createSkillToolsFromManifest(
    parseToolManifestFile(join(dir, "TOOLS.json")).tools,
    dir,
    computeSkillVersionHash(dir),
    true,
  );
  const tool = (name: string) =>
    tools.find((tool) => tool.name === `computer_use_${name}`)!;
  const local = (
    name: string,
    args: Record<string, unknown> = {},
    ctx = context,
  ) => tool(name).execute({ target: "assistant-desktop", ...args }, ctx);
  return {
    released,
    input,
    started,
    releaseBrowser,
    lease,
    tool,
    tools,
    local,
    disable: () => {
      enabled = false;
    },
    uninstall: () => {
      ready = false;
    },
  };
}
function observationId(result: { content: string }) {
  return result.content.match(/observation_id: ([a-f0-9-]+)/)![1]!;
}

test("shared skill executes native actions without a host client and returns fresh observations", async () => {
  const f = fixture();
  let observed = await f.local("observe");
  expect(observed.isError).toBe(false);
  expect(observed.contentBlocks?.[0]?.type).toBe("image");
  expect(observed.content).toContain("Capabilities:");
  const actions = [
    ["click", { x: 100, y: 50 }, { action: "click", button: "left" }],
    [
      "click",
      { x: 100, y: 50, click_type: "double" },
      { action: "click", button: "double" },
    ],
    [
      "click",
      { x: 100, y: 50, click_type: "right" },
      { action: "click", button: "right" },
    ],
    ["type_text", { text: "Example" }, { action: "type", text: "Example" }],
    ["key", { key: "shift+tab" }, { action: "key", key: "shift+Tab" }],
    ["key", { key: "enter" }, { action: "key", key: "Return" }],
    [
      "scroll",
      { x: 100, y: 50, direction: "down", amount: 2 },
      { action: "scroll", amount: 2 },
    ],
    [
      "drag",
      { x: 100, y: 50, to_x: 200, to_y: 80 },
      { action: "drag", to_x: 200, to_y: 80 },
    ],
    ["wait", { duration_ms: 1 }, { action: "wait", duration_ms: 1 }],
  ] as const;
  for (const [name, args, expected] of actions) {
    const previous = observationId(observed);
    observed = await f.local(name, {
      reasoning: "Complete the requested task",
      ...args,
      observation_id: previous,
    });
    expect(observed.isError).toBe(false);
    expect(observationId(observed)).not.toBe(previous);
    expect(f.input.perform.mock.calls.at(-1)?.[0]).toMatchObject(expected);
  }
  expect(f.started).toHaveBeenCalledTimes(1);
  expect(await f.local("done", { summary: "Finished" })).toMatchObject({
    content: "Finished",
    isError: false,
  });
  expect(f.released).toHaveBeenCalled();
});

test("omitted and explicit host targets preserve client routing, click variants and window observations", async () => {
  const f = fixture();
  const proxy = mock<NonNullable<ToolContext["proxyToolResolver"]>>(
    async () => ({ content: "Host observation", isError: false }),
  );
  const ctx = { ...context, proxyToolResolver: proxy };
  for (const target of [undefined, "connected-computer"]) {
    for (const click_type of ["single", "double", "right"] as const) {
      const args = {
        element_id: 7,
        reasoning: "Click the requested button",
        click_type,
        target_client_id: "client-123",
      };
      expect(
        (
          await f
            .tool("click")
            .execute({ ...args, ...(target ? { target } : {}) }, ctx)
        ).isError,
      ).toBe(false);
      expect(proxy.mock.calls.at(-1)).toEqual([
        {
          single: "computer_use_click",
          double: "computer_use_double_click",
          right: "computer_use_right_click",
        }[click_type],
        args,
      ]);
    }
  }
  const args = {
    capture_window_id: 42,
    include_screenshot: true,
    full_tree: true,
    target_client_id: "client-123",
  };
  await f.tool("observe").execute(args, ctx);
  expect(proxy.mock.calls.at(-1)).toEqual(["computer_use_observe", args]);
  expect(f.started).not.toHaveBeenCalled();
});

test.each(["disable", "uninstall"] as const)(
  "%s blocks local calls without fallback and leaves host calls working",
  async (mode) => {
    const f = fixture();
    const proxy = mock(async () => ({ content: "host", isError: false }));
    f[mode]();
    expect(
      (await f.local("observe", {}, { ...context, proxyToolResolver: proxy }))
        .isError,
    ).toBe(true);
    expect(f.started).not.toHaveBeenCalled();
    expect(proxy).not.toHaveBeenCalled();
    expect(
      (
        await f
          .tool("observe")
          .execute({}, { ...context, proxyToolResolver: proxy })
      ).content,
    ).toBe("host");
  },
);

test("invalid targets and unsupported local capabilities never execute on either machine", async () => {
  const f = fixture();
  const proxy = mock(async () => ({ content: "host", isError: false }));
  for (const [name, args] of [
    ["observe", { target: "unknown" }],
    ["observe", { target_client_id: "client-123" }],
    ["observe", { capture_window_id: 42 }],
    ["observe", { full_tree: true }],
    ["click", { element_id: 7 }],
    ["drag", { to_element_id: 8 }],
    ["open_app", { app_name: "Example" }],
    ["run_applescript", { script: "return 1" }],
    ["sequence", { actions: [{ action: "key", key: "enter" }] }],
    [
      "click",
      { target: "connected-computer", observation_id: crypto.randomUUID() },
    ],
  ] as const) {
    const result = await f.local(
      name,
      {
        ...(name === "observe"
          ? {}
          : { reasoning: "Complete the requested task" }),
        ...args,
      },
      { ...context, proxyToolResolver: proxy },
    );
    expect(result.isError).toBe(true);
  }
  expect(f.started).not.toHaveBeenCalled();
  expect(proxy).not.toHaveBeenCalled();
});

test("shared calls enforce browser/native freshness, owner identity and cancelled teardown", async () => {
  const f = fixture();
  const observation = observationId(await f.local("observe"));
  expect(
    (
      await f.local(
        "done",
        { summary: "Done" },
        { ...context, sourceActorPrincipalId: "user-456" },
      )
    ).isError,
  ).toBe(true);
  expect(f.released).not.toHaveBeenCalled();
  await f.lease.runBrowser(context, async () => ({
    content: "navigated",
    isError: false,
  }));
  const stale = await f.local("click", {
    reasoning: "Click",
    x: 10,
    y: 10,
    observation_id: observation,
  });
  expect(stale.isError).toBe(true);
  expect(stale.content).toContain("Stale");
  expect(f.input.perform).not.toHaveBeenCalled();
  await f.local("observe");
  expect(
    (
      await f.local(
        "done",
        { summary: "Stopped" },
        { ...context, signal: AbortSignal.abort() },
      )
    ).content,
  ).toBe("Stopped");
  expect(f.released).toHaveBeenCalled();
});

test("permission routing follows the trusted skill target and cannot downgrade unrelated tools", () => {
  const f = fixture();
  registerSkillTools("computer-use", f.tools);
  try {
    const tool = f.tool("click");
    for (const target of ["connected-computer", "assistant-desktop"] as const) {
      const expected = target === "assistant-desktop" ? "sandbox" : "host";
      expect(resolveExecutionTarget(tool, { target })).toBe(expected);
      expect(
        buildPolicyContext(tool, context, { target }).executionTarget,
      ).toBe(expected);
    }
    expect(resolveExecutionTarget(tool)).toBe("host");
    expect(resolveExecutionTarget(tool, {})).toBe("host");
    for (const args of [
      { target: "assistant-desktop", target_client_id: "client-123" },
      { target: "invalid" },
      { target: "connected-computer", observation_id: crypto.randomUUID() },
    ]) {
      expect(resolveExecutionTarget(tool, args)).toBe("host");
    }
    const dir = join(getBundledSkillsDir(), "computer-use");
    const entry = parseToolManifestFile(join(dir, "TOOLS.json")).tools[0]!;
    const untrusted = createSkillTool(
      entry,
      "/tmp/example-skill",
      computeSkillVersionHash(dir),
      false,
    );
    expect(
      resolveExecutionTarget(untrusted, { target: "assistant-desktop" }),
    ).toBe("host");
    expect(
      resolveExecutionTarget(
        { name: "host_bash", executionTarget: "host" },
        { target: "assistant-desktop" },
      ),
    ).toBe("host");
  } finally {
    unregisterSkillTools("computer-use");
  }
});

test("a web conversation can use native drag only when a supported computer is available", async () => {
  const { isToolActiveForContext } =
    await import("../daemon/conversation-tool-setup.js");
  const env = await import("../config/env-registry.js");
  const { setOverridesForTesting } =
    await import("../__tests__/feature-flag-test-helpers.js");
  const { desktopDependencyInstaller } =
    await import("./desktop-dependencies.js");
  const f = fixture();
  const containerized = spyOn(env, "getIsContainerized").mockReturnValue(true);
  const platform = spyOn(env, "getIsPlatform").mockReturnValue(true);
  const original = desktopDependencyInstaller.getStatus();
  const setup = spyOn(desktopDependencyInstaller, "getStatus").mockReturnValue({
    ...original,
    state: "ready",
  });
  registerSkillTools("computer-use", f.tools);
  const ctx = {
    conversationId: "conversation-123",
    transportInterface: "web",
    clientOs: "web",
    getTurnActorPrincipalId: () => "user-123",
    hasNoClient: false,
  } as unknown as import("../daemon/conversation.js").Conversation;
  try {
    setOverridesForTesting({ "assistant-desktop": true });
    expect(isToolActiveForContext("computer_use_drag", ctx)).toBe(true);
    expect(isToolActiveForContext("computer_use_run_applescript", ctx)).toBe(
      false,
    );
    setup.mockReturnValue({ ...original, state: "required" });
    expect(isToolActiveForContext("computer_use_drag", ctx)).toBe(false);
    setup.mockReturnValue({ ...original, state: "ready" });
    setOverridesForTesting({ "assistant-desktop": false });
    expect(isToolActiveForContext("computer_use_drag", ctx)).toBe(false);
  } finally {
    unregisterSkillTools("computer-use");
    setOverridesForTesting({});
    containerized.mockRestore();
    platform.mockRestore();
    setup.mockRestore();
  }
});

test.each([
  ["type_text", { reasoning: "Type" }],
  ["done", {}],
  ["click", { reasoning: "Click", x: 10, y: 10, unexpected: true }],
] as const)(
  "schema rejection in %s releases only the current owner's lease",
  async (name, args) => {
    const f = fixture();
    const noSession = await f.local(name, args);
    expect(noSession.isError).toBe(true);
    expect(f.started).not.toHaveBeenCalled();
    await f.local("observe");
    const other = await f.local(name, args, {
      ...context,
      sourceActorPrincipalId: "user-456",
    });
    expect(other.isError).toBe(true);
    expect(f.released).not.toHaveBeenCalled();
    const own = await f.local(name, args);
    expect(own.isError).toBe(true);
    expect(own.content).toContain("Invalid input");
    expect(f.input.perform).not.toHaveBeenCalled();
    expect(f.released).toHaveBeenCalled();
  },
);

test("unsupported native observation features release the owner without touching a host", async () => {
  const f = fixture();
  await f.local("observe");
  const proxy = mock(async () => ({ content: "host", isError: false }));
  const result = await f.local(
    "observe",
    { full_tree: true },
    { ...context, proxyToolResolver: proxy },
  );
  expect(result.isError).toBe(true);
  expect(f.released).toHaveBeenCalled();
  expect(proxy).not.toHaveBeenCalled();
});

test("permission simulation passes the invocation target to the policy checker", async () => {
  const { ROUTES } = await import("../runtime/routes/settings-routes.js");
  const handler = ROUTES.find(
    (route) => route.operationId === "tools_simulate_permission_post",
  )!.handler;
  const f = fixture();
  registerSkillTools("computer-use", f.tools);
  const classify = spyOn(permissionChecker, "classifyRisk").mockResolvedValue({
    level: RiskLevel.Low,
    reason: "Test classification",
    matchType: "registry",
    scopeOptions: [],
  });
  const check = spyOn(permissionChecker, "check").mockResolvedValue({
    decision: "allow",
    reason: "Test policy",
  });
  try {
    for (const [input, expected] of [
      [{ target: "assistant-desktop" }, "sandbox"],
      [{ target: "connected-computer" }, "host"],
      [{}, "host"],
      [{ target: "invalid" }, "host"],
    ] as const) {
      await handler({
        body: {
          toolName: "computer_use_observe",
          input,
          workingDir: context.workingDir,
        },
      });
      expect(check.mock.calls.at(-1)?.slice(0, 4)).toEqual([
        "computer_use_observe",
        input,
        context.workingDir,
        { executionTarget: expected, executionContext: "conversation" },
      ]);
    }
    expect(f.started).not.toHaveBeenCalled();
  } finally {
    check.mockRestore();
    classify.mockRestore();
    unregisterSkillTools("computer-use");
  }
});
