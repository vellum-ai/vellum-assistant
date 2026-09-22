import { describe, expect, mock, spyOn, test } from "bun:test";

import { run as click } from "../config/bundled-skills/computer-use/tools/computer-use-click.js";
import * as configLoader from "../config/loader.js";
import { HostCuProxy } from "../daemon/host-cu-proxy.js";
import {
  DesktopAutomationLease,
  desktopAutomationLease,
} from "./desktop-automation-lease.js";
import {
  executeDesktopComputerUse,
  performDesktopComputerUse,
  planDesktopComputerUse,
} from "./desktop-computer-use.js";
import * as sessionManager from "./desktop-session-manager.js";

function driver(userGuidance?: string) {
  return {
    input: mock(async (_args: string[], _signal?: AbortSignal) => {}),
    capture: mock(async (_signal: AbortSignal) => ({
      userGuidance,
      screenshot: "anBlZw==",
      screenshotWidthPx: 1440,
      screenshotHeightPx: 810,
      screenWidthPt: 1440,
      screenHeightPt: 810,
    })),
  };
}

const perform = async (
  toolName: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
  backend: Parameters<typeof performDesktopComputerUse>[2],
) =>
  performDesktopComputerUse(
    planDesktopComputerUse(toolName, input),
    signal,
    backend,
  );

const signal = () => new AbortController().signal;

describe("virtual desktop computer use", () => {
  test("observes without input and returns pixels on repeated observations", async () => {
    const backend = driver();
    for (let i = 0; i < 2; i++) {
      const result = await perform(
        "computer_use_observe",
        {},
        signal(),
        backend,
      );
      expect(result.screenshot).toBe("anBlZw==");
    }
    expect(backend.input).not.toHaveBeenCalled();
    expect(backend.capture).toHaveBeenCalledTimes(2);
  });

  test("runs a sequence in order and captures once after its last action", async () => {
    const backend = driver();
    await perform(
      "computer_use_sequence",
      {
        actions: [
          { action: "click", x: 30, y: 40 },
          { action: "key", key: "ctrl+l" },
          { action: "type", text: "--shell $(example)" },
        ],
      },
      signal(),
      backend,
    );
    expect(backend.input.mock.calls.map(([args]) => args)).toEqual([
      [
        "mousemove",
        "30",
        "40",
        "click",
        "--repeat",
        "1",
        "--delay",
        "100",
        "1",
      ],
      ["key", "--clearmodifiers", "ctrl+l"],
      ["type", "--clearmodifiers", "--delay", "0", "--", "--shell $(example)"],
    ]);
    expect(backend.capture).toHaveBeenCalledTimes(1);
  });

  for (const clickType of ["double", "right"] as const) {
    test(`the bundled click wrapper executes a ${clickType} click`, async () => {
      const backend = driver();
      const proxy = new HostCuProxy(10);
      await click(
        { click_type: clickType, x: 30, y: 40 },
        {
          workingDir: "/tmp",
          conversationId: "conv-123",
          trustClass: "guardian",
          proxyToolResolver: (name, input) =>
            proxy.executeLocal(name, input, () =>
              perform(name, input, signal(), backend),
            ),
        },
      );
      expect(backend.input.mock.calls[0][0]).toEqual([
        "mousemove",
        "30",
        "40",
        "click",
        "--repeat",
        clickType === "double" ? "2" : "1",
        "--delay",
        "100",
        clickType === "right" ? "3" : "1",
      ]);
      expect(backend.capture).toHaveBeenCalledTimes(1);
    });
  }

  test("invalid input does not claim a lease or consume the CU budget", async () => {
    const proxy = new HostCuProxy(1);
    const run = spyOn(desktopAutomationLease, "runBrowser");
    try {
      await expect(
        executeDesktopComputerUse(
          "computer_use_click",
          { element_id: -1 },
          {
            workingDir: "/tmp",
            conversationId: "conv-123",
            trustClass: "guardian",
          },
          proxy,
        ),
      ).rejects.toThrow("element_id must be an integer");
      expect(run).not.toHaveBeenCalled();
      expect(proxy.stepCount).toBe(0);
      expect(proxy.actionHistory).toHaveLength(0);
    } finally {
      run.mockRestore();
    }
  });

  test("an execution failure stops a sequence and returns the resulting screen", async () => {
    const backend = driver();
    backend.input.mockRejectedValueOnce(new Error("Input failed"));
    const result = await perform(
      "computer_use_sequence",
      {
        actions: [
          { action: "key", key: "ctrl+l" },
          { action: "type", text: "example.com" },
        ],
      },
      signal(),
      backend,
    );
    expect(backend.input).toHaveBeenCalledTimes(1);
    expect(result.executionError).toBe("Input failed");
    expect(result.screenshot).toBe("anBlZw==");
  });

  test("done releases only its conversation without starting the desktop", async () => {
    const release = spyOn(
      desktopAutomationLease,
      "releaseForConversation",
    ).mockImplementation(() => {});
    const run = spyOn(desktopAutomationLease, "runBrowser");
    try {
      const proxy = new HostCuProxy(1);
      proxy.recordAction("computer_use_observe", {});
      const result = await executeDesktopComputerUse(
        "computer_use_done",
        { summary: "Finished" },
        {
          workingDir: "/tmp",
          conversationId: "conv-123",
          trustClass: "guardian",
        },
        proxy,
      );
      expect(result).toEqual({ content: "Finished", isError: false });
      expect(release).toHaveBeenCalledWith("conv-123");
      expect(run).not.toHaveBeenCalled();
      expect(proxy.stepCount).toBe(0);
    } finally {
      release.mockRestore();
      run.mockRestore();
    }
  });

  test("tool deadline cancels queued startup before it can perform an action", async () => {
    const config = configLoader.getConfig();
    const getConfig = spyOn(configLoader, "getConfig").mockReturnValue({
      ...config,
      timeouts: { ...config.timeouts, toolExecutionTimeoutSec: 0.01 },
    });
    const run = spyOn(desktopAutomationLease, "runBrowser").mockImplementation(
      async (context) => {
        return new Promise((_, reject) =>
          context.signal!.addEventListener(
            "abort",
            () => reject(context.signal!.reason),
            { once: true },
          ),
        );
      },
    );
    try {
      await expect(
        executeDesktopComputerUse(
          "computer_use_click",
          { x: 1, y: 2, observation_id: "observation-123" },
          {
            workingDir: "/tmp",
            conversationId: "conv-123",
            trustClass: "guardian",
          },
          new HostCuProxy(10),
        ),
      ).rejects.toThrow("Computer use timed out");
      expect(run.mock.calls[0][0].signal?.aborted).toBe(true);
    } finally {
      getConfig.mockRestore();
      run.mockRestore();
    }
  });

  test("validates the whole sequence before any input", async () => {
    const backend = driver();
    await expect(
      perform(
        "computer_use_sequence",
        {
          actions: [
            { action: "click", x: 30, y: 40 },
            { action: "click", element_id: -1 },
          ],
        },
        signal(),
        backend,
      ),
    ).rejects.toThrow("element_id must be an integer");
    expect(backend.input).not.toHaveBeenCalled();
    expect(backend.capture).not.toHaveBeenCalled();
  });

  for (const [tool, input] of [
    ["computer_use_observe", { capture_window_id: 12 }],
    ["computer_use_run_applescript", { script: "return 1" }],
    ["computer_use_click", { x: 1440, y: 10 }],
    ["computer_use_key", { key: "Return click 1" }],
    ["computer_use_scroll", { direction: "down", amount: 100 }],
  ] as const) {
    test(`rejects unsupported input for ${tool} before acting`, async () => {
      const backend = driver();
      await expect(perform(tool, input, signal(), backend)).rejects.toThrow();
      expect(backend.input).not.toHaveBeenCalled();
      expect(backend.capture).not.toHaveBeenCalled();
    });
  }

  test("cancellation releases a held drag button and prevents capture", async () => {
    const backend = driver();
    const abort = new AbortController();
    backend.input.mockImplementation(async (_args, actionSignal) => {
      if (actionSignal) {
        abort.abort();
        actionSignal.throwIfAborted();
      }
    });
    await expect(
      perform(
        "computer_use_drag",
        {
          x: 30,
          y: 40,
          to_x: 300,
          to_y: 400,
        },
        abort.signal,
        backend,
      ),
    ).rejects.toThrow();
    expect(backend.input.mock.calls.at(-1)).toEqual([["mouseup", "1"]]);
    expect(backend.capture).not.toHaveBeenCalled();
  });

  test("an already-cancelled request does not actuate or capture", async () => {
    const backend = driver();
    const abort = new AbortController();
    abort.abort();
    await expect(
      perform("computer_use_click", { x: 30, y: 40 }, abort.signal, backend),
    ).rejects.toThrow();
    expect(backend.input).not.toHaveBeenCalled();
    expect(backend.capture).not.toHaveBeenCalled();
  });

  test("uses the CU step budget and image result format and resets on done", async () => {
    const proxy = new HostCuProxy(1);
    const capture = driver().capture;
    const execute = () => capture(signal());
    const result = await proxy.executeLocal(
      "computer_use_observe",
      {},
      execute,
    );
    expect(result.contentBlocks).toEqual([
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: "anBlZw==",
        },
      },
    ]);
    expect(result.content).toContain("1440x810 px");
    expect(proxy.actionHistory).toHaveLength(1);
    expect(
      (await proxy.executeLocal("computer_use_click", { x: 1, y: 2 }, execute))
        .isError,
    ).toBe(true);
    expect(capture).toHaveBeenCalledTimes(1);
    proxy.endTask("conv-123");
    expect(
      (await proxy.executeLocal("computer_use_observe", {}, execute)).isError,
    ).toBe(false);
  });
});

test("native dispatch consumes observations while preserving CU history, images, and loop warnings", async () => {
  const warning = "Accessibility is unavailable. Use screenshot coordinates.";
  const backend = driver(warning);
  const manager = {
    browser: { release: async () => {} },
    acquireAutomationSlot: () => ({ ok: true }),
    releaseAutomationSlot: () => {},
    ensureDesktopRunning: async () => {},
  } as unknown as sessionManager.DesktopSessionManager;
  const lease = new DesktopAutomationLease({
    enabled: () => true,
    ready: () => true,
    manager: () => manager,
    notify: async () => {},
  });
  const run = spyOn(desktopAutomationLease, "runBrowser").mockImplementation(
    lease.runBrowser.bind(lease),
  );
  const record = spyOn(
    desktopAutomationLease,
    "recordObservation",
  ).mockImplementation(lease.recordObservation.bind(lease));
  const getManager = spyOn(
    sessionManager,
    "getDesktopSessionManager",
  ).mockReturnValue(manager);
  const context = {
    workingDir: "/tmp",
    conversationId: "conv-123",
    sourceActorPrincipalId: "user-123",
    trustClass: "guardian" as const,
  };
  const proxy = new HostCuProxy(20);
  const call = (name: string, input: Record<string, unknown> = {}) =>
    executeDesktopComputerUse(
      name,
      { target: "assistant-desktop", ...input },
      context,
      proxy,
      backend,
    );
  const id = (result: { content: string }) =>
    result.content.match(/observation_id: ([a-f0-9-]+)/)![1]!;
  try {
    await expect(call("computer_use_click", { x: 30, y: 40 })).rejects.toThrow(
      "observation_id",
    );
    expect(run).not.toHaveBeenCalled();
    expect(proxy.stepCount).toBe(0);
    const observed = await call("computer_use_observe");
    expect(observed.contentBlocks?.[0]).toMatchObject({ type: "image" });
    expect(observed.content).toContain(`USER GUIDANCE: ${warning}`);
    expect(observed.content).toContain("pass the latest observation_id");
    const firstId = id(observed);
    let result = await call("computer_use_click", {
      x: 30,
      y: 40,
      observation_id: firstId,
    });
    expect(id(result)).not.toBe(firstId);
    const steps = proxy.stepCount;
    await expect(
      call("computer_use_click", { x: 30, y: 40, observation_id: firstId }),
    ).rejects.toThrow("stale");
    expect(backend.input).toHaveBeenCalledTimes(1);
    expect(proxy.stepCount).toBe(steps);
    for (let i = 0; i < 3; i++) {
      result = await call("computer_use_click", {
        x: 30,
        y: 40,
        observation_id: id(result),
      });
    }
    expect(result.content).toContain("repeated");
    await lease.runBrowser(context, async () => ({
      content: "browser action",
      isError: false,
    }));
    await expect(
      call("computer_use_key", { key: "Return", observation_id: id(result) }),
    ).rejects.toThrow("stale");
    const refreshed = await call("computer_use_observe");
    const sequenced = await call("computer_use_sequence", {
      observation_id: id(refreshed),
      actions: [
        { action: "key", key: "ctrl+l" },
        { action: "type", text: "example.com" },
      ],
    });
    expect(backend.input.mock.calls.at(-1)?.[0]).toContain("example.com");
    backend.input.mockRejectedValueOnce(new Error("Input failed"));
    const failed = await call("computer_use_key", {
      key: "Return",
      observation_id: id(sequenced),
    });
    expect(failed.isError).toBe(true);
    expect(failed.contentBlocks?.[0]).toMatchObject({ type: "image" });
    expect(failed.content).not.toContain("observation_id:");
    expect(failed.content).toContain("Call computer_use_observe");
    expect(lease.isActive).toBe(false);
    const recovered = await call("computer_use_observe");
    expect(id(recovered)).toBeTruthy();
  } finally {
    await lease.runBrowser(
      context,
      async () => ({ content: "", isError: false }),
      true,
    );
    run.mockRestore();
    record.mockRestore();
    getManager.mockRestore();
  }
});
