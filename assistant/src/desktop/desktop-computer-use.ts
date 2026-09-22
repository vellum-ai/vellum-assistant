import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { getConfig } from "../config/loader.js";
import type {
  CuObservationResult,
  HostCuProxy,
} from "../daemon/host-cu-proxy.js";
import { safeTimeoutMs } from "../tools/execution-timeout.js";
import type { ToolContext, ToolExecutionResult } from "../tools/types.js";
import { DesktopAccessibility } from "./desktop-accessibility.js";
import { desktopAutomationLease } from "./desktop-automation-lease.js";
import {
  DESKTOP_DISPLAY,
  DESKTOP_HEIGHT,
  DESKTOP_WIDTH,
} from "./desktop-display.js";
import { getDesktopSessionManager } from "./desktop-session-manager.js";

const exec = promisify(execFile);
const KEY_ALIASES: Record<string, string> = {
  enter: "Return",
  return: "Return",
  esc: "Escape",
  escape: "Escape",
  tab: "Tab",
  space: "space",
  backspace: "BackSpace",
  delete: "Delete",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
  pageup: "Prior",
  pagedown: "Next",
  ctrl: "ctrl",
  alt: "alt",
  shift: "shift",
  super: "super",
  control: "ctrl",
  option: "alt",
  cmd: "super",
  command: "super",
};

type Action =
  | { args: string[]; drag?: boolean }
  | { wait: number }
  | { toolName: string; input: Record<string, unknown> };
type DesktopComputerUseBackend = {
  input: (args: string[], signal?: AbortSignal) => Promise<void>;
  capture: (signal: AbortSignal) => Promise<CuObservationResult>;
  resolveElement?: (
    id: number,
    observationId: string,
    signal: AbortSignal,
  ) => Promise<{ x: number; y: number }>;
  bindObservation?: (id: string) => void;
};

async function run(
  executable: string,
  args: string[],
  signal?: AbortSignal,
): Promise<void> {
  await exec(executable, args, {
    env: { PATH: process.env.PATH, LANG: "C.UTF-8", DISPLAY: DESKTOP_DISPLAY },
    signal,
    timeout: 15_000,
    windowsHide: true,
  });
}

const accessibility = new DesktopAccessibility();
const backend: DesktopComputerUseBackend = {
  resolveElement: (id, observationId, signal) =>
    accessibility.resolve(id, observationId, signal),
  bindObservation: (id) => accessibility.bindObservation(id),
  input: (args, signal) => run("xdotool", args, signal),
  capture: async (signal) => {
    const { default: sharp } = await import("sharp");
    const dir = await mkdtemp(join(tmpdir(), "desktop-cu-"));
    try {
      const path = join(dir, "screen.png");
      await run("scrot", ["--pointer", path], signal);
      const { data, info } = await sharp(path)
        .jpeg({ quality: 80 })
        .toBuffer({ resolveWithObject: true });
      signal.throwIfAborted();
      const tree = await accessibility.observe(
        getDesktopSessionManager().accessibilityBusAddress,
        signal,
      );
      return {
        ...tree,
        screenshot: data.toString("base64"),
        screenshotWidthPx: info.width,
        screenshotHeightPx: info.height,
        screenWidthPt: DESKTOP_WIDTH,
        screenHeightPt: DESKTOP_HEIGHT,
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};

function integer(
  value: unknown,
  name: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function position(input: Record<string, unknown>, prefix = ""): string[] {
  return [
    String(integer(input[`${prefix}x`], `${prefix}x`, 0, DESKTOP_WIDTH - 1)),
    String(integer(input[`${prefix}y`], `${prefix}y`, 0, DESKTOP_HEIGHT - 1)),
  ];
}

function assertScreenTarget(input: Record<string, unknown>): void {
  if (
    ["capture_window_id", "captureWindowId", "captureDisplayId"].some(
      (key) => input[key] !== undefined,
    )
  ) {
    throw new Error(
      "Virtual desktop computer use supports full-screen capture only. Scoped capture is unavailable.",
    );
  }
}

function planAction(
  toolName: string,
  input: Record<string, unknown>,
): Action[] {
  assertScreenTarget(input);
  const targetKeys = ["element_id", "to_element_id"] as const;
  if (targetKeys.some((key) => input[key] !== undefined)) {
    const validationInput = { ...input };
    for (const key of targetKeys) {
      if (input[key] === undefined) {
        continue;
      }
      integer(input[key], key, 1, Number.MAX_SAFE_INTEGER);
      if (
        !(key === "to_element_id"
          ? toolName === "computer_use_drag"
          : [
              "computer_use_click",
              "computer_use_double_click",
              "computer_use_right_click",
              "computer_use_scroll",
              "computer_use_drag",
            ].includes(toolName))
      ) {
        throw new Error(`${key} is unsupported for ${toolName}`);
      }
      const prefix = key === "to_element_id" ? "to_" : "";
      delete validationInput[key];
      validationInput[`${prefix}x`] = 0;
      validationInput[`${prefix}y`] = 0;
    }
    planAction(toolName, validationInput);
    return [{ toolName, input }];
  }
  switch (toolName) {
    case "computer_use_observe":
      return [];
    case "computer_use_double_click":
    case "computer_use_right_click":
    case "computer_use_click": {
      const type =
        toolName === "computer_use_double_click"
          ? "double"
          : toolName === "computer_use_right_click"
            ? "right"
            : (input.click_type ?? "single");
      if (!["single", "double", "right"].includes(String(type))) {
        throw new Error("click_type must be single, double, or right");
      }
      return [
        {
          args: [
            "mousemove",
            ...position(input),
            "click",
            "--repeat",
            type === "double" ? "2" : "1",
            "--delay",
            "100",
            type === "right" ? "3" : "1",
          ],
        },
      ];
    }
    case "computer_use_type_text": {
      if (typeof input.text !== "string" || input.text.includes("\0")) {
        throw new Error("text must be a string without null characters");
      }
      return [
        {
          args: ["type", "--clearmodifiers", "--delay", "0", "--", input.text],
        },
      ];
    }
    case "computer_use_key": {
      if (
        typeof input.key !== "string" ||
        !/^[a-zA-Z0-9_]+(?:\+[a-zA-Z0-9_]+)*$/.test(input.key)
      ) {
        throw new Error("key must be a key name or a shortcut such as ctrl+l");
      }
      const key = input.key
        .split("+")
        .map((part) =>
          Object.hasOwn(KEY_ALIASES, part.toLowerCase())
            ? KEY_ALIASES[part.toLowerCase()]
            : part,
        )
        .join("+");
      return [{ args: ["key", "--clearmodifiers", key] }];
    }
    case "computer_use_scroll": {
      const buttons: Record<string, string> = {
        up: "4",
        down: "5",
        left: "6",
        right: "7",
      };
      const button =
        typeof input.direction === "string" &&
        Object.hasOwn(buttons, input.direction)
          ? buttons[input.direction]
          : undefined;
      if (!button) {
        throw new Error("direction must be up, down, left, or right");
      }
      const amount = integer(input.amount, "amount", 1, 10);
      const move =
        input.x !== undefined || input.y !== undefined
          ? ["mousemove", ...position(input)]
          : [];
      return [
        {
          args: [
            ...move,
            "click",
            "--repeat",
            String(amount),
            "--delay",
            "50",
            button,
          ],
        },
      ];
    }
    case "computer_use_drag":
      return [
        {
          args: [
            "mousemove",
            ...position(input),
            "mousedown",
            "1",
            "sleep",
            "0.1",
            "mousemove",
            ...position(input, "to_"),
            "sleep",
            "0.1",
            "mouseup",
            "1",
          ],
          drag: true,
        },
      ];
    case "computer_use_wait":
      return [{ wait: integer(input.duration_ms, "duration_ms", 0, 10_000) }];
    default:
      throw new Error(
        `${toolName} is unavailable on the virtual desktop. Use screenshots, coordinates, and keyboard shortcuts to interact with its apps.`,
      );
  }
}

export function planDesktopComputerUse(
  toolName: string,
  input: Record<string, unknown>,
): Action[] {
  assertScreenTarget(input);
  if (toolName !== "computer_use_sequence") {
    return planAction(toolName, input);
  }
  if (
    !Array.isArray(input.actions) ||
    input.actions.length < 1 ||
    input.actions.length > 10
  ) {
    throw new Error("A sequence must contain between 1 and 10 actions");
  }
  return input.actions.flatMap((action: unknown) => {
    if (!action || typeof action !== "object" || Array.isArray(action)) {
      throw new Error("Each sequence action must be an object");
    }
    const entry = action as Record<string, unknown>;
    const aliases: Record<string, string> = {
      type: "type_text",
      double_click: "click",
      right_click: "click",
    };
    const name = String(entry.action);
    return planAction(
      `computer_use_${Object.hasOwn(aliases, name) ? aliases[name] : name}`,
      {
        ...entry,
        ...(name === "double_click"
          ? { click_type: "double" }
          : name === "right_click"
            ? { click_type: "right" }
            : {}),
      },
    );
  });
}

export async function performDesktopComputerUse(
  actions: Action[],
  signal: AbortSignal,
  driver: DesktopComputerUseBackend = backend,
  observationId = "",
): Promise<CuObservationResult> {
  let executionError: string | undefined;
  try {
    for (let action of actions) {
      signal.throwIfAborted();
      if ("toolName" in action) {
        const input = { ...action.input };
        for (const key of ["element_id", "to_element_id"] as const) {
          if (input[key] === undefined) {
            continue;
          }
          if (!driver.resolveElement) {
            throw new Error(
              "Accessibility is unavailable. Observe again and use screen coordinates.",
            );
          }
          const point = await driver.resolveElement(
            Number(input[key]),
            observationId,
            signal,
          );
          const prefix = key === "to_element_id" ? "to_" : "";
          input[`${prefix}x`] = point.x;
          input[`${prefix}y`] = point.y;
          delete input[key];
        }
        action = planAction(action.toolName, input)[0]!;
      }
      if ("toolName" in action) {
        throw new Error("Accessibility target could not be resolved");
      }
      signal.throwIfAborted();
      if ("wait" in action) {
        await delay(action.wait, undefined, { signal });
      } else {
        try {
          await driver.input(action.args, signal);
        } finally {
          if (action.drag) {
            await driver.input(["mouseup", "1"]);
          } else if (
            signal.aborted &&
            ["key", "type"].includes(action.args[0])
          ) {
            await driver.input([
              "keyup",
              "Shift_L",
              "Shift_R",
              "Control_L",
              "Control_R",
              "Alt_L",
              "Alt_R",
              "Super_L",
              "Super_R",
            ]);
          }
        }
      }
    }
  } catch (error) {
    signal.throwIfAborted();
    executionError = error instanceof Error ? error.message : String(error);
  }
  await delay(150, undefined, { signal });
  return {
    ...(await driver.capture(signal)),
    ...(executionError ? { executionError } : {}),
  };
}

export async function executeDesktopComputerUse(
  toolName: string,
  input: Record<string, unknown>,
  context: ToolContext,
  proxy: HostCuProxy,
  driver: DesktopComputerUseBackend = backend,
): Promise<ToolExecutionResult> {
  const done =
    toolName === "computer_use_done" || toolName === "computer_use_respond";
  if (done) {
    desktopAutomationLease.releaseForConversation(context.conversationId);
    proxy.endTask(context.conversationId);
    return {
      content: String(input.summary ?? input.answer ?? "Task complete"),
      isError: false,
    };
  }
  const actions = planDesktopComputerUse(toolName, input);
  const observe = toolName === "computer_use_observe";
  if (
    !observe &&
    (typeof input.observation_id !== "string" || !input.observation_id)
  ) {
    throw new Error(
      "An observation_id from computer_use_observe with target assistant-desktop is required before acting.",
    );
  }
  const deadline = new AbortController();
  const timer = setTimeout(
    () =>
      deadline.abort(
        new Error(
          "Computer use timed out. Check virtual desktop setup and observe again before acting.",
        ),
      ),
    safeTimeoutMs(getConfig().timeouts.toolExecutionTimeoutSec),
  );
  try {
    return await desktopAutomationLease.runBrowser(
      {
        ...context,
        signal: context.signal
          ? AbortSignal.any([context.signal, deadline.signal])
          : deadline.signal,
      },
      (signal) =>
        proxy.executeLocal(toolName, input, async () => {
          await getDesktopSessionManager().browser.release();
          const observation = await performDesktopComputerUse(
            actions,
            signal,
            driver,
            String(input.observation_id ?? ""),
          );
          signal.throwIfAborted();
          const observationId =
            observation.executionError == null
              ? desktopAutomationLease.recordObservation()
              : undefined;
          if (observationId) {
            driver.bindObservation?.(observationId);
          }
          return {
            ...observation,
            userGuidance: [
              observation.userGuidance,
              "On this virtual desktop, pass the latest observation_id with each action or sequence; it is consumed once. Observe again after browser actions, user handoff, errors, or interruption.",
              "Use Linux shortcuts such as ctrl+l and open apps through the dock or desktop UI. open_app, AppleScript, window-scoped capture, and full_tree are unsupported. Call computer_use_done with the same target when finished.",
            ]
              .filter(Boolean)
              .join("\n"),
            executionResult:
              observation.executionError != null
                ? "Target: assistant-desktop. Call computer_use_observe before continuing."
                : `Target: assistant-desktop. observation_id: ${observationId}`,
          };
        }),
      false,
      observe ? undefined : { id: input.observation_id },
    );
  } finally {
    clearTimeout(timer);
  }
}
